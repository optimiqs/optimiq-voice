# FIX — the `rpc.sip.v1.credential` capacity ceiling

Area owned: `apps/api/src/pbx/sip-credentials` (+ the one wiring block in `apps/api/src/pbx/pbx.module.ts`),
`packages/events` (granted), `config/nats.conf` (granted). Nothing committed, staged or stashed.
`apps/sipd` and `apps/engine` untouched.

---

## 1. Profile — where the 510/s went

Measured against the live stack, before any change, with `TestE2ECredentialRPCBurst`.

### Harness note that had to be fixed first

`apps/sipd/e2e_load_test.go` connects with `nats.Connect(url, nats.UserInfo(...))` and **no
`nats.CustomInboxPrefix`**. The `sipd` broker user's subscribe grant is `_INBOX.sipd.>`, so a
default-prefix `_INBOX.<nuid>.*` subscription is refused and **every request times out** —
`burst 400: 400 failed, wall 5.001s`, which reads exactly like a dead responder. The daemon itself
and every other sipd test (`e2e_bindings_test.go`, `credential_integration_test.go`,
`integration_test.go`) do set `nats.CustomInboxPrefix("_INBOX.sipd")`; this one file does not. It is
a real gap in the harness, in `apps/sipd`, which is another agent's area — see "Cross-area needed".
I measured with the `operator` credential (`_INBOX.>`) instead, which reproduces `E2E-load.md`'s
numbers to within noise, and changed nothing in that file.

### Per-lookup work, counted at the database

`pg_stat_user_tables` / `pg_stat_database` deltas across one 400-wide burst, `optimiq_pbx`:

|                                | delta over 400 lookups | per lookup           |
| ------------------------------ | ---------------------- | -------------------- |
| `xact_commit`                  | 1 212                  | **3.0 transactions** |
| `org_setting` scans            | 403                    | 1.0                  |
| `device_line` scans            | 402                    | 1.0                  |
| `extension` scans              | 405                    | 1.0                  |
| `shared_line_appearance` scans | 401                    | 1.0                  |

Three transactions, four queries. Expanded, one answer is **eleven client↔server round trips**:

```
1   select org_setting …                                  (adminDb, untenanted — the realm directory)
2-6 begin / set local role / set_config / select device_line ⋈ extension / commit   (findLine)
7-11 begin / set local role / set_config / select shared_line_appearance / commit   (findSharedLineAppearance)
```

`withTenantScope` costs four round trips of pure ceremony per use, and the path uses it twice.

### The CPU is not the constraint

V8 CPU profile of the running api (`SIGUSR1` + `Profiler.start`, 200 µs sampling) across three
400-wide bursts, 53 279 samples:

```
 90.62 %  (idle)
  0.80 %  (garbage collector)
  0.81 %  drizzle-orm/sql/sql.js        ← query building
  0.71 %  postgres/src/connection.js    ← wire
  0.18 %  sip-credentials.responder.js
  0.18 %  sip-credentials.service.js
```

Nine per cent busy over the window, and the two files under audit are a third of a per cent of it.
The api was never CPU-bound and the pool was never the bound (`E2E-load.md`: 5 of 10 backends).
The ceiling is arithmetic: `MAX_IN_FLIGHT = 32` answers in flight × ~63 ms per answer (burst-1 p50
was 32 ms; 11 serialized round trips under load) ⇒ **32 ÷ 0.063 ≈ 508/s**, which is the 503–510/s the
burst table shows flat from 400 concurrent upward. Raising `MAX_IN_FLIGHT` would only move the
queueing from the responder into the pool. The fix is to stop doing the eleven.

**Top costs, ranked:** (1) two `withTenantScope` transactions = 8 of the 11 round trips, (2) the
untenanted realm directory query, run once per lookup for a fact that changes when somebody migrates
a domain, (3) a full `zod` parse of `process.env` per lookup (`loadProvisioningEnv`), (4) the
shared-line appearance query, a whole transaction for two integers that decide no authentication.

---

## 2. The cache

New: `apps/api/src/pbx/sip-credentials/sip-credentials.cache.ts` (`SipCredentialCache`).

- **Two maps.** `realm → organizationId` (the directory, 300 s), and
  `(organizationId, realm, username) → SipCredentialResponse`. Keys are NUL-joined, so a realm or an
  auth id containing the separator cannot collide two tenants' entries (tested).
- **TTLs.** Positive 60 s; negative 5 s (unknown account, and an unmapped realm); the directory 300 s
  for a mapping and 5 s for "nothing maps to this realm".
- **Bounded.** 20 000 entries per map, oldest-insertion-first eviction, and a hit re-inserts, so what
  survives pressure is what is actually registering — the negative key space is chosen by whoever is
  sending REGISTERs, which is why there is a cap and not only a TTL.
- **What is NOT cached:** a missing `PROVISION_SIP_SECRET_KEY`, a database error, a malformed
  request. Those are not facts about a row, and remembering one would turn a transient fault into a
  minute of fleet-wide refusals.
- **`loadProvisioningEnv()` moved behind the cache check**, so the per-request `zod` parse of
  `process.env` only runs on a miss.

### Invalidation is exact

`pbx.module.ts`'s `onMutation` seam — the one every PBX write passes through, `provisioning`'s device
CRUD included, since it shares `PBX_EFFECT_RUNTIME` — now evicts the tenant **first and
synchronously**, before the four fire-and-forget projection publishes. Tables:
`extension`, `device`, `device_line`, `shared_line`, `shared_line_appearance`, `org_setting`
(`affectsSipCredentials`); `org_setting` additionally drops the realm directory
(`changesTheSipRealm`), because a realm change invalidates a key belonging to no tenant.

Whole-organization rather than per-account, deliberately: the seam reports a table and a tenant, not
a row, and a `device_line.auth_user` edit invalidates the entry under the **old** username, which the
new row does not know. Eviction is a few thousand map deletes on a path that runs when a human clicks
save.

### Security properties preserved

- The tenant/realm resolution is unchanged — the cache sits in front of `resolveOrganizationForRealm`
  and the per-tenant key, never around the tenant boundary.
- The reply carries exactly what it carried before; no new field, no secret beyond the HA1 the
  responder already returned.
- **A cached refusal still files its `sip_auth_event` row and still logs.** This was the one real
  hazard: caching an `unknown-account` would have made a credential spray invisible to the attack log
  after its first packet. `reportRefusal` re-derives the event kind from the cached response and
  records on every attempt; only the queries are skipped. Tested.
- A disable takes effect on the **commit**, not on the TTL.

---

## 3. `credential.invalidated` — the channel sipd does not have

`FIX-sipd-followups.md` §5 established there is none. There is now.

**Subject:** `provision.evt.v1.<orgId>` — the existing provisioning family, whose own header says
the subject stops at the org and the discriminator lives in the envelope `type` "because
provisioning volume is tiny and every consumer wants the whole org feed". That is this event
exactly, and it is the family that already owns the password in question (`provision.service.ts`
derives what a phone is given; the credential responder repeats that derivation). A root of its own
would have cost a fourth stream, family, consumer and grant for one message per administrator click.

**Envelope `type`:** `credential.invalidated`.

**Payload** (`credentialInvalidatedDataSchema`, Go `ProvisionCredentialInvalidatedData`):

```json
{
	"id": "…",
	"at": "…",
	"orgId": "…",
	"subject": "provision.evt.v1.<orgId>",
	"source": "api",
	"type": "credential.invalidated",
	"data": { "reason": "update on extension", "dropped": 12 }
}
```

`reason` is `"<operation> on <table>"` — a human string for a log line, not something to branch on.
`dropped` is how many entries the API shed; diagnostics only, legitimately 0. **No username, no
realm, no digest**: a subscriber learns that something changed, never what it changed to.

**Semantics for sipd:** whole-organization. Drop everything the credential cache holds. With one
`SIPD_REALM` per deployment that is the whole cache; the `Refresher` bound added in §5 stays as the
backstop for a missed message. Go constant: `contract.EventTypeProvisionCredentialInvalidated`.

**Publisher:** the responder's existing NATS connection (`announceInvalidation`), core publish, no
JetStream ack — the subject is stream-captured so a connected subscriber gets it and it is retained,
but an administrator's save must not wait on a broker. `SipCredentialCache.setAnnouncer` is
registered only when `NATS_URL` is set; without it the eviction is silent, which is all it could be.

**Broker grants:** `apps/api` already publishes `provision.evt.v1.*` (nats.conf L200) — **no api
grant change was needed**. Added to the **sipd subscribe** allow-list: `"provision.evt.v1.*"`, as a
core subscription, with the same argument the file already makes for the MWI subject (a durable
consumer would replay a provisioning backlog at every restart). It is the narrowest grant that
exists for this family; it does also carry `device.requested`/`rendered`/`rejected`, which are
provisioning records (a MAC, a path, a user agent, a template id) and hold no secret. Broker reloaded
with `kill -HUP`: `Reloaded server configuration (sha256:3dbf4bbe…)`, **zero new permission
violations**.

**Cross-area (sipd, not done here):** subscribe core to `provision.evt.v1.*`, decode the envelope,
and on `type == "credential.invalidated"` flush `internal/credentials`' cache for that deployment.

---

## 4. Before / after

`TestE2ECredentialRPCBurst`, same broker, same roster, same `operator` credential in both columns.
The api was **not restarted by me** — it was restarted at 20:32 UTC by the `engine-perf` agent, after
my edits landed, and booted them cleanly (`serving rpc.sip.v1.credential over NATS`, no DI error).
Both the before and the after runs were taken with other agents' work on the same stack, so every
after number is pessimistic rather than flattering.

| Burst | before p50 / p99  | before over 500 ms | **after (warm) p50 / p99** | after over 500 ms |
| ----- | ----------------- | ------------------ | -------------------------- | ----------------- |
| 50    | 86 ms / 135 ms    | 0                  | **1 ms / 1 ms**            | 0                 |
| 200   | 281 ms / 448 ms   | 0                  | **3 ms / 5 ms**            | 0                 |
| 400   | 462 ms / 841 ms   | **176**            | **5 ms / 9 ms**            | 0                 |
| 800   | 794 ms / 1.542 s  | **569**            | **5 ms / 10 ms**           | 0                 |
| 1 000 | 1.021 s / 1.957 s | **783**            | **18 ms / 29 ms**          | 0                 |

Throughput, from the wall time of the whole burst:

|                  | before              | after (warm)         |
| ---------------- | ------------------- | -------------------- |
| 400 concurrent   | 844 ms → **474/s**  | 10 ms → **40 000/s** |
| 1 000 concurrent | 1.964 s → **509/s** | 30 ms → **33 300/s** |

**Target was ≥5 000/s with p99 well under 100 ms at 400 concurrent. Measured: ~40 000/s, p99 9 ms.**
Zero requests over the 500 ms contract at any burst size, where 400-wide put 176 over it before.

A **cold** 1 000-wide burst — 1 000 distinct accounts nothing has ever asked about, which is a
process's first second and not a steady state — is 18 ms wall (p99 16 ms), because a cold miss now
costs one query round instead of eleven serialized ones behind a 32-deep gate.

### The database is out of the path, counted

Same `pg_stat` deltas as the profile, over a warm 400-wide burst:

|                                | before, per lookup | after, per lookup |
| ------------------------------ | ------------------ | ----------------- |
| `optimiq_pbx` transactions     | 3.0                | **0**             |
| `device_line` scans            | 1.0                | **0**             |
| `extension` scans              | 1.0                | **0**             |
| `shared_line_appearance` scans | 1.0                | **0**             |
| `org_setting` scans            | 1.0                | **0**             |

(The handful of counts that do move during the window belong to other agents' traffic on the shared
stack; the four credential tables move by exactly zero.)

### The invalidation, proved on the live stack

Subscribed to `provision.evt.v1.>` as `operator`, then created one extension through the real API:

```
GOT provision.evt.v1.01a08708-4cd4-76b9-b56d-d26ebf326b0a
{"id":"01a087fd-e487-734b-891a-ac9cd2d7ddf1","at":"2026-09-09T21:05:58.407Z",
 "orgId":"01a08708-4cd4-76b9-b56d-d26ebf326b0a",
 "subject":"provision.evt.v1.01a08708-4cd4-76b9-b56d-d26ebf326b0a",
 "type":"credential.invalidated","source":"api",
 "data":{"reason":"create on extension","dropped":1000}}
```

And the eviction is real, not a TTL: the very next 400-wide burst went **back to p50 497 ms /
p99 846 ms** — the pre-fix cold numbers — because one write had emptied the tenant's 1 000 entries.
The probe extension (`7311`, id `01a087fd-e42a-…`) was deleted afterwards; `DELETE 200`. Nothing else
on the stack was touched.

---

## Files changed

| File                                                                                         | Change                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/pbx/sip-credentials/sip-credentials.cache.ts`                                  | **new** — the cache, the two table predicates, the announcer seam                                                                             |
| `apps/api/src/pbx/sip-credentials/sip-credentials.service.ts`                                | `resolve` split into a cached front and `lookUp`; `organizationForRealm`; `reportRefusal`; `loadProvisioningEnv` moved behind the cache check |
| `apps/api/src/pbx/sip-credentials/sip-credentials.responder.ts`                              | registers the announcer; `announceInvalidation` publishes the event; `announcedCount`                                                         |
| `apps/api/src/pbx/pbx.module.ts`                                                             | `SipCredentialCache` provider; eviction first in `onMutation`                                                                                 |
| `apps/api/test/pbx/sipCredentialCache.test.ts`                                               | **new** — 15 cases                                                                                                                            |
| `apps/api/test/pbx/sipCredentials.test.ts`, `sipCredentialsResponder.test.ts`                | constructor arity                                                                                                                             |
| `packages/events/src/schemas/provision-events.ts`, `schemas/index.ts`, `scripts/registry.ts` | the event                                                                                                                                     |
| `packages/events-go/*_gen.go`, `packages/events/schema/**`                                   | codegen output                                                                                                                                |
| `config/nats.conf`                                                                           | one sipd subscribe grant                                                                                                                      |

## Tests

`apps/api/test/pbx/sipCredentialCache.test.ts`: hit (zero queries, not fewer), miss, invalidation
round-trip, the announcement and its `dropped` count, positive TTL (59 s hit / 61 s miss), negative
caching of an unknown account **with the attack-log row still filed on every attempt**, a disabled
account likewise, a deployment failure not cached, tenant isolation of keys in both directions plus
cross-realm and cross-org misses, separator collision, realm-directory drop, unmapped-realm short
TTL, and the eviction bound at 20 000. Plus three predicate cases for the mutation seam.

## Verification

```
pnpm --filter @optimiq-voice/api  run typecheck   PASS (tsconfig.json + tsconfig.strict.json, 0 errors)
pnpm --filter @optimiq-voice/api  run test        1349 passing, 0 failing
   of which test/pbx/sipCredential*.test.ts       23 passing, 0 failing
pnpm --filter @optimiq-voice/events run typecheck PASS (0 errors)
pnpm --filter @optimiq-voice/events run test      396 pass, 12 skip, 0 fail (408 across 13 files)
pnpm --filter @optimiq-voice/events run codegen   PASS (idempotent; regenerated events-go + schema/)
cd packages/events-go && go build ./... && go test ./...   ok (0.190s)
pnpm exec turbo run typecheck --filter=...@optimiq-voice/events   16 successful, 16 total
pnpm exec oxlint  <src + test dirs, packages/events>  exit 0, no diagnostics
pnpm exec oxfmt   <same>                              clean, no reformat churn outside my edits
```

Broker: `kill -HUP` on the running NATS, `Reloaded server configuration (sha256:3dbf4bbe…)`, zero new
permission violations in the log afterwards. (The reload also picked up other agents' pending
nats.conf edits that were already on disk — they were applied, not written, by me.)

## Cross-area needed

1. **`apps/sipd/e2e_load_test.go`** — add `nats.CustomInboxPrefix("_INBOX.sipd")` to the
   `nats.Connect` in `TestE2ECredentialRPCBurst` (and to `loadRoster`'s connection if it has one).
   Without it the test reports a 100 % failure rate against a perfectly healthy responder, which is
   a measurement that will mislead whoever runs it next.
2. **`apps/sipd/internal/credentials`** — subscribe to `provision.evt.v1.*` and flush on
   `credential.invalidated`, per §3. The broker grant is already in place.
