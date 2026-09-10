# E2E — resilience, restart and load

Stack per `STACK.md`. I owned the stack for this pass and was the only agent restarting services
(another agent was concurrently EDITING `apps/engine` and `apps/api` and driving calls of its own;
its traffic appears in the logs and is called out where it matters).

Artifacts: `<scratchpad>/e2e/artifacts/resilience/` — one per-second RTP log per scenario, plus the
reusable harness `apps/sipd/e2e_resilience_test.go` (`TestE2EHoldACallOpen`) that produced them.

---

## Phase 1 — rolling the fixed code onto the live stack

### Restart round 1 (18:21–18:22 UTC)

| Service | Down                    | Rebuilt    | Health after | New broker violations |
| ------- | ----------------------- | ---------- | ------------ | --------------------- |
| sipd    | 18:21:25 → :29, ~4 s    | `go build` | 200          | 0                     |
| mediad  | 18:21:34 → :38, ~4 s    | `go build` | 200          | 0                     |
| engine  | 18:21:41 → :51, ~10 s   | `dist`     | 200          | 0                     |
| api     | 18:21:56 → :22:00, ~4 s | —          | 200          | 0                     |

`/connz?auth=1`: `sipd` 1, `mediad` 1, `engine` 2, `api` 22 — four distinct authenticated users.

**The `$JS.FC.>` question is settled — confirmed.** The engine's last
`Publish Violation — Subject "$JS.FC.KV_routing-cache…"` is at 12:32:13 local, _before_ its restart.
The violation total has been frozen at 986 ever since, and the two `$JS.FC.>` subjects that repeated
every 5 s for hours have not appeared once. The `REGISTRATIONS` grants likewise took: the api logged
`sip auth event consumer running` with no refusal.

### Verifications the restarts unblocked

| Item (from the FIX-_/E2E-_ "needs restart" lists) | Verdict               | Evidence                                                                                                    |
| ------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Routing-artifact updates apply within a second    | **PASS**              | `POST /routing/compile` at 18:39:09.0xx → engine `/healthz.routing.lastWatchEntryAt` 18:39:09.115. ~100 ms. |
| `/healthz` exposes the `routing` section          | **PASS**              | `{"watching":true,"cached":3,"invalidations":5,"staleRecoveries":0,"lastWatchEntryAt":…}`                   |
| sipd dead-WS-contact reaping                      | **PASS**              | `swept bindings whose connection closed count:11`, 5 s after boot                                           |
| sipd registration-scope ACL                       | **PASS**              | `a sip-acl entry was withdrawn key:203-0-113-0-24`; `aclEntries:1 aclLoaded:true`                           |
| sipd trunks watch                                 | **PASS**              | `trunk directory loaded trunks:1`                                                                           |
| The trunk scenario `E2E-sip.md` left **BLOCKED**  | **PASS**              | `TestE2ETrunkInboundDID`: DID → extension 1601 in **13 ms**, carrier final 200 after 17 ms                  |
| Two-tenant registration                           | **PASS**              | both realms REGISTER 200; a tenant credential on the other realm → **403**                                  |
| auth-failed → `sip_auth_event`                    | **PASS, after a fix** | see P0-2                                                                                                    |
| Caller cancel CANCELs the ringing callee          | **PASS**              | `TestE2ECancelRace`: CANCEL 200, INVITE ends **487 Request Terminated** (was 404 before)                    |
| Full smoke call on the restarted tree             | **PASS**              | two-way audio, hold/resume, hangup, 2 CDR legs (`6b8040da-…`)                                               |
| Presence/trunk watches survive a broker restart   | **FAIL, then fixed**  | see P0-3                                                                                                    |
| Extension recording policy records                | **not re-run**        | see "Not tested"                                                                                            |
| Refused originates are not "answered" in CDR      | **not re-run**        | see "Not tested"                                                                                            |

`smoke-call.mjs` now needs `STACK_REALM=<unique>.local.test`: the SIP realm became a per-tenant
unique claim, so its hard-coded `local.test` 409s against the original smoke org. Worth fixing in
the script.

### The loopback ACL row, and what deleting it exposed

Deleted `sip_acl_entry 01a0871d-359e-76f4-aa47-03cb78302343` through the API, as instructed. **With
it gone the external profile answers an unauthenticated loopback INVITE `403 Forbidden`** (it had
been answering 200 for a routed DID and 404 for an unrouted one). `TestE2ETrunkInboundDID` therefore
fails now, and that failure is the proof the brief asked for.

Deleting it was not cosmetic — see P0-1 and P1-1, which it uncovered.

---

## P0 findings

### P0-1 — a revoked SIP ACL rule stays in force for ever (FIXED)

`apps/api/src/pbx/security/sip-acl.publisher.ts`

The `sip-acl` key changed from the folded network alone (`127-0-0-1-32`) to
`<orgId>.<scope>.<network>`. The reconcile's delete pass was changed with it, to a range read over
`kvKeyFor.sipAclPrefix(organizationId)` — **which cannot see a single-token legacy key**. Nothing
else deletes one. The class header states the rule this breaks in as many words: _"a network that
keeps being admitted after the rule that admitted it was deleted"_ is the direction this boundary
must never fail in. Its own `reconcile` doc still described the whole-key-space scan the code no
longer does.

Proven live, not inferred: after the API accepted `DELETE /sip-acl-entries/01a0871d-…` (200, and the
list came back empty), `KV_sip-acl` still held `127-0-0-1-32 rev 19 PUT {"action":"allow",…}`, sipd
still admitted on it, and the trunk test still passed.

**Fix**: the reconcile also sweeps `bucket.keys("*")` — `*` matches exactly one token, which is
precisely the legacy shape — and deletes the entries whose own `orgId` is this organization.
Another tenant's legacy key is left to the rebuild script.
Tests: `apps/api/test/pbx/sipAclProjection.test.ts` → "deletes a legacy key this organization wrote
before the key carried the organization" and "leaves a legacy key belonging to another organization
alone" (the fake bucket now honours a `*` filter, which the reconcile depends on).

**Verified live**: after the api restart, one throwaway ACL entry forced a reconcile and sipd logged
`a sip-acl entry was withdrawn key:"127-0-0-1-32"`. The bucket is now empty and the edge refuses.

### P0-2 — every refused REGISTER crashed the api consumer and redelivered for ever (FIXED)

`SipAuthEventConsumer.dispatch` threw
`TypeError: Cannot read properties of undefined (reading 'record')` on **every** `auth-failed` event
sipd published, NAKed it, and got it back 5 s later — for ever, with a full stack trace each time.
Thirty such cycles are in `api.log`. Consequences: no brute-force attempt from the SIP edge was ever
recorded (the only `sip_auth_event` rows in `registration` scope came from the api's own
credential-lookup path, with no source IP), and a poison message burns CPU and log volume without
bound.

**Root cause, proved rather than guessed.** The local stack ran the api as `tsx src/main.ts`. `tsx`
compiles with esbuild, which does not emit `design:paramtypes`:

```
WithInject design:paramtypes = undefined
BareOnly   design:paramtypes = undefined
```

So **every Nest provider injected by bare class type — any constructor parameter with no `@Inject`
token — was `undefined`**, silently: with no metadata a constructor looks dependency-free, Nest
raises nothing, and the provider fails only when it first touches the collaborator. At least a dozen
providers have that shape (`voicemail-transcription-sweeper`, `voicemail-consumer`,
`ring-groups.controller`, `recording-retention-policy`, `emergency-consumer`,
`conference-moderation.controller`, `call-flows.controller`, `paging-groups.controller`,
`reseller-telephony-usage.controller`, …). Production is unaffected — the Dockerfile runs
`tsc`-built `dist/index.js`.

**Fix**: `.scripts/local-stack/up.sh` builds and runs the api from `dist`, exactly as it already did
for the engine and for the same documented reason. Restart cost ~15 s instead of ~5 s.

**Verified live**: a fresh wrong-password REGISTER now files
`bad-credentials | registration | 127.0.0.1 | 1601 | udp | sipua-e2e | {"aor":"sip:1601@local.test","reason":"bad-credentials"}`.
The redelivery loop stopped.

_This finding is retrospective for the whole audit campaign_: any api behaviour another agent
recorded as "the service did nothing" before 18:38 UTC should be re-run. It is also why the api is
now slower to restart.

### P0-3 — a broker restart kills presence platform-wide until something reboots (FIXED)

`presence` is `storage: "memory"` (deliberately — a 5-minute-TTL read model). A broker restart
destroys the stream while the engine keeps a `KV` handle bound to it, and `ensureKvBuckets` runs
once, at boot. Observed after the first NATS restart:

- engine: `failed to publish presence … NatsError: 503`, twice a second, for ever;
- sipd: `the presence watch ended; re-establishing it` → `cannot re-establish the presence watch:
nats: stream not found`, backing off 1→2→4→8→16→30 s and retrying at 30 s indefinitely.

Every busy lamp in the fleet is dark and no NOTIFY is composed until a process restarts. sipd's
watch is correct — it retries for ever with a 30 s ceiling — so the missing piece was purely that
_nobody recreates a memory bucket_.

**Fix**: `apps/engine/src/nats/jetstream.service.ts` re-applies `ensureKvBuckets` on a `reconnect`
status and logs which buckets it had to recreate. Idempotent; a no-op for the file-backed ones. A
failure is logged, not thrown — throwing out of the status iterator would end the only thing
watching the connection.
Tests: `jetstream.service.spec.ts` → "re-applies the KV definitions on a reconnect, so a lost memory
bucket comes back" and "does not re-apply them on a disconnect, which has lost nothing yet".

**Verified live**: second broker restart, engine logged
`recreated KV buckets the broker had lost buckets:["presence"]` **10 ms after the reconnect**, and
sipd's watch never even reported a failure. Repeatable — it happened again on the third restart.

### P0-4 — a `mediad` crash strands every call, mute and un-hangup-able (PARTIALLY FIXED)

SIGKILL `mediad` with a two-party call up (18:47:37):

- media stops within 1 s (correct — mediad is the relay);
- the engine notices in 0.7 s: `mediad stopped answering reachability probes; readiness is degraded`,
  `/healthz` → `degraded`, `media.ready:false`. **That half works.**
- **the engine never hangs the call up.** Both phones sat in a live, silent call for the 36 s until
  the test's own BYE. Nothing named a cause, nothing filed, nothing told the far end.
- worse, the engine's hangup path itself needed mediad: `failed to hang up a channel … release-session
… no reply within 500ms`. When mediad is gone the engine **cannot** hang up.
- and the leg leaked: `SplitPlaneMediaPort.hangup` released media inside a `finally` and
  `releaseSession`'s throw propagated _out of_ it, skipping `forget(channelId)`. The leg stayed
  pinned in the port and counted in `activeChannels` for the life of the process.

**Fixed half** — `apps/engine/src/media/split-plane.port.ts`: `releaseMediaQuietly` treats an
unreachable relay as released, so `hangup` and `releaseEndedLeg` always reach `forget`. A relay that
died holding the session has nothing left to leak on its side; the only thing a failed release can
still cost is the state on this side. Tests: `split-plane.port.spec.ts` → "BYEs and forgets the leg
even when the media relay never answers the release" and the `releaseEndedLeg` twin.
Verified live on a repeat kill: `the media relay did not confirm a session release; dropping the leg
anyway`, and the leg is dropped.

**NOT fixed, and the more important half**: nothing proactively terminates calls when the media plane
is lost. The engine has the signal (`mediad.reachable` flips within a second) and the ability (the
SIP hangup goes to sipd, not mediad), but no watchdog joins them. **Recommended**: on the transition
to `reachable:false`, hang up every channel whose media session that instance owned, with a named
cause (`MEDIA_OWNER_LOST`), so a CDR is filed and both legs get a BYE. Left for the engine's owner —
it is a behaviour change in another agent's area, not a leak fix.

A residual discrepancy also stands: after the repeat kill `/healthz.activeChannels` stayed at 2 while
the `channels` KV held the right live set. The split-plane leg state is now released but the
orchestrator's registry entry is not.

### P0-5 — a `sipd` crash leaves an unkillable zombie call (NOT FIXED)

SIGKILL `sipd` mid-call, restart 10 s later:

- **media flows unbroken through the whole thing** — 50 packets/s, zero loss, right across the kill
  and the restart. Correct: mediad relays without sipd.
- the engine **never notices**. Not one log line; `sipd.selected:true` throughout; `activeChannels`
  went 2 → 3.
- the dialog state is gone with the process: the phone's BYE is answered **481 Call/Transaction Does
  Not Exist**. The call cannot be ended from either end. It is a billing leg with live audio and no
  signalling.
- registrations are lost with it. The harness re-registers itself; a real handset is unreachable
  until its next REGISTER — up to 300 s.

Expected per the brief — "phones re-register, the call ends cleanly, no stuck dialogs in the
sip-dialogs KV after the reaper runs" — is not what happens. `sip-dialogs` held **19 live keys**
against 2 live channels afterwards; they are TTL-bounded (6 h) rather than unbounded, but the reaper
does not remove them promptly.

**Recommended**: the engine should watch sipd instance liveness the way it watches mediad's, and a
sipd that comes back with a new instance token should have its predecessor's dialogs reconciled from
the `sip-dialogs` KV — either re-adopted or hung up.

---

## Phase 2 — scenario table

| #   | Action                                   | Expected                                                                                  | Observed                                                                                                                                                                                                                                                                          | Recovery                                                   | Evidence                                              | Verdict                             |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| 1   | NATS `kill -TERM`, 17 s down, same store | services reconnect, watches resume, in-progress media keeps flowing, new call within 10 s | **media unbroken: 50 pkt/s, 0 lost, across the whole outage.** All four users reconnected. New call succeeded 18 s after the broker returned.                                                                                                                                     | broker back 1.3 s; api's 22 conns all back **1.1 s** later | `s1-nats.log`, CDR `f971df7f` 76.07 s NORMAL_CLEARING | **PASS**                            |
| 1b  | same, KV watches                         | acl/trunks/presence resume                                                                | acl + trunks fine (file-backed). **presence dead for ever**                                                                                                                                                                                                                       | —                                                          | P0-3                                                  | **FAIL → fixed**                    |
| 1c  | same, after the P0-3 fix                 | presence resumes                                                                          | `recreated KV buckets … ["presence"]` 10 ms after reconnect; sipd's watch never failed                                                                                                                                                                                            | **10 ms**                                                  | engine.log 18:45:39.605                               | **PASS**                            |
| 2   | `docker restart` Postgres mid-call       | api recovers pools, CDR resumes, no lost legs, auth works                                 | media unaffected (0 lost). PG accepting connections immediately; `auth/ok` 200 on the first poll; sign-in 73 ms, `/extensions` 12 ms. **CDR complete, `cdr_write_quarantine` empty.**                                                                                             | **< 8 s end to end**                                       | `s2-pg.log`, CDR `4ae37182` 56.06 s                   | **PASS**                            |
| 3   | `mediad` SIGKILL mid-call                | engine detects owner loss, hangs up both legs with a cause, CDR filed, ports freed        | detects in 0.7 s and degrades; **never hangs up**; cannot hang up; leaked the leg                                                                                                                                                                                                 | never                                                      | P0-4, `s3-mediad.log`                                 | **FAIL** (leak fixed, teardown not) |
| 4   | `sipd` SIGKILL mid-call + restart        | phones re-register, call ends cleanly, no stuck dialogs                                   | media unbroken; engine never notices; BYE → 481; 19 stuck dialogs                                                                                                                                                                                                                 | never                                                      | P0-5, `s4-sipd.log`                                   | **FAIL**                            |
| 5   | `engine` SIGTERM mid-call                | documented graceful drain                                                                 | **exactly as documented**: the call survives the full 30 s drain with 0 lost packets, then `drain deadline reached; hanging up the remaining channels` and both legs get a BYE. Exit 30.0 s after the signal; with no calls it exits in 7.8 s. After restart `activeChannels: 0`. | 30 s (the configured deadline)                             | `s5-engine.log`, engine.log 18:55:05→:35              | **PASS**                            |

---

## Phase 3 — measurements

### Call quality, steady state (the harness, repeated across every scenario)

| Metric                                     | Value                 |
| ------------------------------------------ | --------------------- |
| setup-to-ring                              | **12–19 ms** (5 runs) |
| ring-to-answer                             | 3–4 ms                |
| RTP rate, both directions                  | 50 packets/s, exactly |
| Packets lost, ~11 500 packets over 5 calls | **0**                 |
| G.711 energy                               | 5088, flat            |

### The api's 22 NATS connections — measured, and the answer is "leave them"

One per publisher/consumer/responder, all on the same `api` credential and the same options:
`agent-state, call-flow-presence, cdr-recordings, cdr-writer, conference-control, did-index,
emergency, live, originate, provision-events, queue-membership, routing-cache, routing-rpc, session,
sip-acl, sip-auth-event, sip-credentials, trunk-directory, trunk-status, voicemail, voicemail-mwi,
webhooks`.

It is a _deliberate_ design, documented per class — "these publishers have different lifetimes under
failure and sharing a field would couple their shutdown ordering", "two connections to the same
broker from one process is a socket, not an architecture". The premise worth testing is the one the
pairwise argument never addressed: does 22 of them cost a reconnect storm?

**Measured, on a broker `kill -TERM` + restart:**

```
before:   api=22 engine=2 mediad=1 sipd=1
broker back after 1.29s
t+0.0s    api=21     ← 21 of 22 were already back before the first sample
t+1.1s    api=22
… flat at 22 for the next 25 s
```

**Full reconnect in ~1.1 s, no storm, no thundering herd, no slow-consumer counters moved.** Per
`NET_BRIEF.md` discipline — measure before changing — **the measurement does not justify the
consolidation.** I did not do it.

The one cost that IS real and that this measurement does not cover is linear in replicas: 22 sockets
and 22 reconnect buffers per api pod, against a broker `max_connections`. At one replica it is
noise; at fifty pods it is 1 100 connections for work that three would carry. If it is ever
consolidated, the defensible split is **three**: control-plane request/reply + KV publishing, durable
consumers (so a drain cannot stop them mid-ack), and the live hub on its own (slow-consumer blast
radius). Not one.

### Log noise — 7.2 WARN+ lines per call in sipd, almost none actionable

241 calls admitted; 1 745 WARN+ERROR lines in `sipd.log`, 989 in `engine.log`.

| Message                                         | Count | Per call | Verdict                                                                                                                                                                               |
| ----------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to parse` (ERROR, with the raw payload) | 600   | —        | **Worst offender.** An unparseable datagram is an ERROR _with the attacker's bytes in it_. The rate is chosen by whoever sends garbage. Should be DEBUG, or counted and rate-limited. |
| `refusing a hangup` (WARN)                      | 286   | 1.19     | A stale WS binding produces one of these plus…                                                                                                                                        |
| `refusing an originate` (WARN)                  | 282   | 1.17     | …one of these, both with a full dial error. The pair is one fact.                                                                                                                     |
| `ACK missed` (WARN)                             | 274   | **1.14** | Named in the brief. One per answered call, no action.                                                                                                                                 |
| `WS ref went negative` (WARN)                   | 92    | 0.38     | Named in the brief. It comes from **sipgo** (`transport_tcp.go:277`), not from sipd — it needs the library logger filtered, not a sipd edit.                                          |
| engine `the sip edge refused a dialog command`  | 571   | 2.37     | The engine-side echo of the two sipd refusals. The same event is logged three times across two services.                                                                              |

The four the brief names are 3.5 lines per call between them and none carries an action. I did not
change them: they are `apps/sipd`'s and `apps/engine`'s, they are cosmetic next to the P0s above, and
`WS ref went negative` needs a library-logger decision rather than a code edit.

### KV bucket occupancy (live keys, after ~2 h of multi-agent testing)

| Bucket           | Live keys | Stream msgs | TTL               | Note                                                                                       |
| ---------------- | --------- | ----------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `channels`       | 2         | 786         | —                 | matches the live set                                                                       |
| `sip-dialogs`    | **19**    | 792         | 6 h               | 17 orphans against 2 live channels; TTL-bounded, but the reaper is not clearing them       |
| `media-owners`   | **1 223** | 1 223       | 6 h               | every call leaves `call.<hash>` + `session.<hash>` behind; bounded by TTL, not by teardown |
| `media-sessions` | 5         | 2 363       | —                 | teardown works here                                                                        |
| `presence`       | 2         | 4           | 5 min, **memory** | P0-3                                                                                       |
| `registrations`  | 7         | 14          | —                 | fine                                                                                       |

`media-owners` and `sip-dialogs` are **not** unbounded leaks — the 6-hour TTL is the backstop and it
has not elapsed on this stack — but neither is emptied on teardown, so both hold six hours of dead
calls rather than the live set. At real call volume that is the number to watch against the 128 MiB
cap.

Also present: an empty stray bucket **`KV_KV_routing-cache`** (subjects `$KV.KV_routing-cache.>`),
created 17:02:18. Not mine. The only in-repo occurrence of that name
(`apps/engine/src/routing/routing-watch-stall.spec.ts:99`) spawns its own broker, so this is almost
certainly a diagnostic script an agent pointed at the live broker with the stream name where the
bucket name belongs. Harmless and safe to delete.

### One new broker permission violation

`user:engine — Subscription Violation — "calls.evt.v1.>"` from a client named `dtmf-observer`, at
13:28:50 local. Not a service connection name; almost certainly another agent's diagnostic client
using the engine credential. Total went 986 → 987 and has not moved since. Worth confirming the
engine itself never needs `calls.evt.v1.>` as a subscribe grant, since `config/nats.conf` does not
give it one.

---

## The profile-selection hole this pass uncovered (NOT FIXED — P0, needs its owner)

Deleting the loopback ACL row restored internal calling, and _why_ it had broken is the finding.

With that `127.0.0.1/32` trunk-scope allow in force, an INVITE from **1601 to 1602 arriving on the
internal UDP listener (5160)** was classified `profile:"external"`, `authentication:"trunk-acl"`,
attributed to the `sip-e2e carrier` trunk, and refused 404 "nothing on this platform owns 1602". The
authenticated internal phone had been silently reclassified as an unauthenticated carrier peer.

`profile.Set.For` (`apps/sipd/internal/profile/profile.go:311`) tries the listener the request
arrived on first — but **sipgo never sets `Destination()` on an inbound request**. Both
`transport_udp.go:235` and `transport_tcp.go:229` call only `SetSource`. That fast path is therefore
dead for every inbound message, and selection always falls through to matching the SOURCE address
against each external profile's ACL. The guard at line 347 only checks that the transport matches,
not the listener address, so the external profile (udp 5162) wins requests that arrived on the
internal one (udp 5160).

Consequences: any tenant who can create a trunk ACL entry covering a network can (a) break every
internal phone on that network, cross-tenant, and (b) route INVITEs from it through the
**digest-free** trunk-ACL path attributed to their own trunk. WSS and TLS are unaffected — only the
internal profile serves them, so the `len(matches)==1` branch settles it. **UDP and TCP are the
exposed pair.**

I did not fix it: with sipgo v1.4.3 the two profiles cannot be told apart on a shared transport
family without the local address, so any change confined to `For` either keeps the hole or breaks
real carrier traffic on 5162 (which today is admitted _only_ by the source step). **The remedy is to
make the destination real.** sipgo exposes `TransportReadFilter`, which receives
`TransportReadProps{Transport, LocalAddr, RemoteAddr}` before parsing; sipd does not use it. Stamping
the local address from there and selecting by listener restores the fast path the code already wants,
after which the source step can be narrowed to listenerless external profiles only — which is what
its own comment says it exists for.

---

## Fixes applied

| #    | File                                             | Change                                                                                       | Test                                                                       |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0-1 | `apps/api/src/pbx/security/sip-acl.publisher.ts` | reconcile sweeps single-token legacy keys owned by this org; stale `reconcile` doc corrected | `apps/api/test/pbx/sipAclProjection.test.ts` (+2, fake bucket honours `*`) |
| P0-2 | `.scripts/local-stack/up.sh`                     | api built and run from `dist`, not `tsx`                                                     | proved by the probe + a live `bad-credentials` row                         |
| P0-3 | `apps/engine/src/nats/jetstream.service.ts`      | `reapplyDefinitions()` on `reconnect`                                                        | `jetstream.service.spec.ts` (+2)                                           |
| P0-4 | `apps/engine/src/media/split-plane.port.ts`      | `releaseMediaQuietly` — a failed release no longer skips `forget`                            | `split-plane.port.spec.ts` (+2)                                            |
| —    | `apps/sipd/e2e_resilience_test.go`               | new: `TestE2EHoldACallOpen`, the per-second RTP harness every scenario above used            | is the test                                                                |

### Verification

- `pnpm --filter @optimiq-voice/api run typecheck` — clean.
- `pnpm --filter @optimiq-voice/api run test` — **1263 passing, 1 failing**. The failure is
  `permission enforcement coverage … stale DOCUMENTED_UNENFORCED entries: cdr.read.own` — the
  concurrent agent's in-flight work, not mine; my `sipAclProjection` tests pass.
- `pnpm --filter @optimiq-voice/engine run typecheck` — clean.
- `bun test` in `apps/engine` — **1628 pass, 20 skip, 0 fail**, 73 files.
- `go vet -tags e2e ./...` and `gofmt -l` in `apps/sipd` — clean.
- `apps/sipd` e2e suite: register transports/expiry/limit, malformed SIP, cancel race, two-tenant,
  phone-to-phone (99 RTP packets each way, DTMF, hold/resume, BYE 200), trunk ACL refusal — all pass.
  `TestE2ETrunkInboundDID` fails **by design** now that the loopback ACL row is gone.

---

## Not tested, and why

- **Second-engine ownership adoption.** Needs a second engine on another health port; I ran one
  instance throughout so as not to change what the other agent was exercising. The SIGTERM drain
  semantics are measured above; adoption is not.
- **`engine` SIGKILL mid-call** (mediad watchdog releases, sipd tears down, CDR reconciled). Not run.
- **`api` SIGSTOP 60 s.** The records agent already ran exactly this and logged it in `STACK.md`; I
  did not repeat it on a stack another agent was using.
- **JetStream disk-full / slow-consumer.** Would need a second broker on a tmpfs `-sd` with a low
  `max_file_store`; doing it on the shared store risked the running stack. Not run.
- **The call storm (100 / 200 concurrent, then 1 000 registrations churning with 50 calls).** Not
  run. The harness above is the right building block — it already registers, calls, streams G.711
  and reports per-second RTP — but driving 200 of them needs a pool runner and per-service CPU /
  pprof / event-loop-lag sampling that I did not build. The steady-state single-call numbers are the
  only load figures here.
- **autocannon against the hot list endpoints / `/me/softphone`, and the
  `AUTH_DATABASE_MAX_CONNECTIONS=10` ceiling.** Not run.
- **Extension recording policy, and refused originates not filed as "answered".** Both are engine
  changes that the restart activated, but re-running them needs the records agent's fixtures.

## State left behind

The stack is **running and healthy**. Data I touched: the loopback ACL row (deleted, as instructed);
one throwaway ACL entry created and deleted; org `01a08768-82cc-7239-8a69-f441feb26fe9`
(realm `res1.local.test`) from my smoke run. Nothing of another agent's was deleted. Nothing
committed; git state untouched.
