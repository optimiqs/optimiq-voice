# FIX — platform gaps (capability-matrix P1s)

Five P1 rows from `CAPABILITY-MATRIX.md`. Items 1 and 3 below were done directly; items 2, 4 and 5
were delegated to parallel agents over disjoint file sets and are reported in `FIX-raybaum.md`,
`FIX-reporting.md` and `FIX-porting-cnam.md`, summarised here.

No commit, no stage, no git state touched.

---

## 1. SSO client secrets encrypted at rest — FIXED

> Matrix row: _Secrets handling | PARTIAL | … SSO client secrets are stored and returned in
> plaintext through the repository projection despite a comment claiming otherwise
> (`packages/db/src/platform-sso.ts:37-49`)_

### The brief's premise was wrong, and that changed the shape of the fix

The task said to "reuse the existing secret-encryption seam used for trunk/SIP secrets
(API_CLOAK_ENCRYPTION_KEY-style config in packages/config)". **There is no such seam.** Verified:

- `API_CLOAK_ENCRYPTION_KEY` appears only in `plans/identity-removal.md`, as a legacy Fonoster
  variable that was _removed_. It is in no live code and no env template.
- `packages/config/src/env.ts` declares no encryption key of any kind. Its only crypto-adjacent
  export is `MINIMUM_SECRET_LENGTH = 32` and `assertResolvedSecret`.
- What exists for SIP is **HMAC derivation, not encryption**: `provision-secret.ts`'s
  `deriveSipPassword` is one-way with no decrypt counterpart, keyed by `PROVISION_SIP_SECRET_KEY`
  (validated by an _app-local_ zod schema in `provisioning-env.ts`, not by packages/config).
- Trunk secrets are not stored at all — `trunk-credentials.service.ts` fetches the password live
  from Telnyx and caches only the ha1.

Derivation cannot work here: an IdP's client secret is chosen by the IdP and must be **presented
back** verbatim at the auth boot, so it has to survive a round trip. Encryption was the only option,
so a seam had to be built. It follows the `provisioning-env.ts` precedent for key handling
(package-local validation, `process.env`) rather than editing `packages/config`, which I do not own.

### What was built

`packages/db/src/secret-cipher.ts` (new) — AES-256-GCM **envelope** encryption.

- Per-record single-use data key (DEK), sealed under a platform key (KEK) from
  `PLATFORM_SECRET_ENCRYPTION_KEY` (32 bytes, hex or base64).
- Why an envelope rather than encrypting under the KEK directly: the KEK then encrypts a fixed 32
  bytes per row instead of attacker-influenced plaintext of unbounded length, which keeps its GCM
  nonce budget uninteresting; and a KEK rotation becomes a re-wrap of DEKs rather than a
  decrypt-and-re-encrypt of every secret, so plaintext never has to be materialised to rotate.
- Format `v1.<wrappedDek>.<wrapIv>.<wrapTag>.<iv>.<tag>.<ciphertext>`, base64url. The version prefix
  is what makes `isEncryptedSecret` decidable, which is what makes the lazy migration possible.
- Exports: `encryptSecret`, `decryptSecret`, `openStoredSecret`, `isEncryptedSecret`,
  `loadSecretKey` (returns `null` when unset), `requireSecretKey` (throws — every write path),
  `secretsEqual`, `SecretCipherError`.
- `loadSecretKey` is lenient and `requireSecretKey` is strict on purpose: a deployment that never
  configured a key has only legacy plaintext rows, and refusing to boot would take SSO down to fix a
  problem that key does not yet have. Writers must never be lenient.

`packages/db/src/platform-sso.ts` — `createSsoProvider` and `updateSsoProvider` seal on the way in;
`listEnabledSsoProvidersWithSecrets` (still the only decryptor, still unreachable from a request
handler) opens on the way out. Both ends live in that one file so no caller ever holds a ciphertext.

**Migration is both one-shot and lazy.** `listEnabledSsoProvidersWithSecrets` re-writes any plaintext
row it reads, sealed, so a running deployment converges by itself and signs in throughout. That only
covers _enabled_ rows, though — a provider an admin disabled while investigating stays plaintext
indefinitely, which is exactly the row nobody watches. `packages/db/scripts/encrypt-sso-secrets.ts`
(new, `pnpm --filter @optimiq-voice/db run db:encrypt-sso-secrets`, `--dry-run` supported) closes
that set in one pass. It is idempotent (`isEncryptedSecret` skips sealed rows) and logs the provider
slug and org, never the secret or its length. It is a script and not a drizzle migration because the
ciphertext is produced by application code holding a key that deliberately does not live in the
database — and because it is not a schema change: the column is `text` before and after, which is
what lets the two formats coexist during a rollout.

**No DB migration was needed**, which is the point above.

Also changed: `.env.voice.example` and `.scripts/local-stack/render-env.sh` gained
`PLATFORM_SECRET_ENCRYPTION_KEY`. The local-stack generator gets a dedicated line rather than
joining the loop, because the loop emits `openssl rand -hex 24` (24 bytes) and AES-256 needs
exactly 32.

### Live evidence (stack per STACK.md; api restarted, pid 66380)

```
POST /api/v1/sso/providers  clientSecret="SUPER-SECRET-VALUE-123"  -> 200 {hasClientSecret:true}

psql> select provider_id, left(client_secret,28), length(client_secret) ...
      okta-sso85998 | v1.BY6rsTi4TGc7p4j9h_ISx8Ftn… | 157
psql> select count(*) ... where client_secret like '%SUPER-SECRET-VALUE-123%';   -> 0
psql> sealed=1  plaintext=0

listEnabledSsoProvidersWithSecrets()  ->  okta-sso85998 -> "SUPER-SECRET-VALUE-123"
```

Lazy migration, forced back to a pre-fix row:

```
psql> update ... set client_secret='LEGACY-PLAINTEXT-XYZ';   -> LEGACY-PLAINTEXT-XYZ
listEnabledSsoProvidersWithSecrets()  ->  okta-sso85998 -> "LEGACY-PLAINTEXT-XYZ"
psql> select left(client_secret,20), length ...  ->  v1.wzLy6VccVpiR6XNkb… | 154
```

One-shot script, on a **disabled** row the lazy path cannot reach:

```
--dry-run : {"event":"sso_secret_sealed",...} {"total":1,"sealed":1,"alreadySealed":0}
real      : {"total":1,"sealed":1,"alreadySealed":0}   -> column now v1.pSsaZWcnZD8rb…
re-run    : {"total":1,"sealed":0,"alreadySealed":1}   (idempotent)
```

Test row deleted afterwards.

### Tests

`packages/db/src/secret-cipher.spec.ts` (new, 14 cases): round trip incl. unicode/empty/4KB, no two
ciphertexts alike for one input, plaintext absent from ciphertext, wrong key refused, **tampered
ciphertext refused**, **a wrapped DEK swapped in from another record refused**, prefix recognition,
legacy passthrough, missing-key behaviour on both the lenient and strict path, hex/base64/blank key
parsing, constant-time compare. `apps/api/test/auth/sso.test.ts` gained 4 cases pinning the
properties the SSO path depends on.

---

## 3. E.164 normalisation — FIXED

> Matrix row: _E.164 normalisation | PARTIAL | Validation only … Missing half: normalising a
> user-entered national number into E.164_

### The audit

Every number surface **refused** non-E.164 rather than normalising, in **four divergent copies of
the same regex**:

| Where                                               | Rule                | Trims? | Max digits |
| --------------------------------------------------- | ------------------- | ------ | ---------- |
| `pbx/shared/dto.ts` `e164`                          | `^\+[1-9]\d{1,18}$` | no     | **19**     |
| `pbx/fax/fax.dto.ts` (module-private, shadowing)    | `^\+[1-9]\d{1,14}$` | yes    | 15         |
| `pbx/org-settings/org-settings.catalog.ts` (inline) | `^\+[1-9]\d{1,18}$` | yes    | 19         |
| `apps/web/lib/pbx/schemas.ts`                       | `^\+[1-9]\d{1,18}$` | yes    | 19         |

So the platform disagreed with itself about what a phone number is depending on which form you
filled in, and `+1 (212) 555-0100` — the shape people copy out of a contact card — was a 400
everywhere. Worse, the caller-ID fields were not validated as numbers **at all**: `callerIdNumber`,
`outboundCallerIdNumber`, `emergencyCallerIdNumber` (extensions) and `callerIdNumberOverride`
(outbound routes, trunks) were bare `z.string().max(32)`, and originate's `callerIdNumber` was 128
characters of free text.

### What was built

`packages/telephony/src/e164.ts` (new). `normalizeE164` / `normalizeE164Message` / `toE164` /
`isE164` / `describeE164Rejection`. Strips punctuation, maps `+` / `00` / `011` to a `+`, and
prepends a `defaultCallingCode` when the caller supplies one.

**No libphonenumber**, deliberately, and the module says why: this package has zero runtime
dependencies by design (it is used by the engine, control plane, CDR writer and routing compiler),
and libphonenumber's multi-megabyte table answers a question this platform does not ask — whether a
national number is plausible for its numbering plan. The carrier answers that authoritatively, and a
local table that disagrees with Telnyx is worse than no table because it refuses numbers that work.

Two deliberate, documented approximations: the NANP long-distance `1` is stripped from an 11-digit
national number (an area code cannot begin with 1), and a leading domestic trunk `0` is stripped
elsewhere. Both are stated in the doc-comment rather than hidden.

**A real constraint worth recording:** `E164Result` is a discriminated union, and `apps/api` compiles
with `strictNullChecks: false` (its tsconfig explains why — a ~170-error cleanup the ESM migration
deliberately did not take on). Without that flag TypeScript widens the `ok: true`/`ok: false`
literals, so `if (result.ok)` narrows **nothing** — and this module is compiled by that app. The
implementation is therefore written in a flat `{ e164, reason, message }` shape and the union is a
thin shell over it, so neither the module nor its callers need a cast.

Wired in:

- `pbx/shared/dto.ts` — `e164` now **normalises** (via a new `e164In(defaultCallingCode)` factory);
  new `callerIdNumber` export. The bound tightened 19 → E.164's real 15. Nothing legitimate lives
  between the two; a 19-digit "number" was a typo the DTO accepted and the carrier would refuse.
- `fax.dto.ts` — divergent private copy deleted, uses the shared one.
- `org-settings.catalog.ts` — inline regex replaced with the shared `e164`.
- `extensions.dto.ts`, `outbound-routes.dto.ts`, `trunks.dto.ts` — the five caller-ID number columns
  are real numbers now.
- `calls.dto.ts` — originate's `callerIdNumber` is `e164`.
- `apps/web/lib/pbx/schemas.ts` — same implementation client-side, so the value the form settles on
  is byte-for-byte the value the API stores (which is what stops a form showing one spelling and the
  list showing another after a save).

`@optimiq-voice/telephony` added as a dependency of `apps/api` and `apps/web`.

### Deliberately NOT changed (and why)

- **`to` on originate, `forward*Destination`, `followMe.destination`, queue member `contact`** —
  `dialableString`. These accept an extension or a feature code as readily as a number; normalising
  them to E.164 would break internal targets. Correct as they are.
- **`call-block.pattern`, `inbound-routes.callerIdPattern`, `routing.destinationNumber/callerNumber`** —
  patterns and simulator inputs, compiled by `packages/routing`. Not numbers.
- **The softphone dial pad** (`_components/softphone/softphone-dialer.tsx`) — a dial pad must accept
  extensions and feature codes. No normalisation belongs there.
- **A bare national number is still refused platform-wide.** `normalizeE164` returns
  `no-country-code` rather than guessing `+1`, because guessing would silently route a British
  tenant's calls to Manhattan. `e164In(code)` exists for a surface that resolves the organization's
  country; **no org setting carries a country code today**, so nothing calls it yet — see
  "Follow-ups" below.

### Live evidence

```
typed=+1 (212) 555-0177  ->  +12125550177
typed=+1.212.555.0178    ->  +12125550178
typed=0012125550179      ->  +12125550179
bare "2125550180" -> 400 "must be E.164 … no default country is configured"
"+9999999999999999" (16) -> 400 "is longer than the 15 digits E.164 allows"
```

### Tests

`packages/telephony/src/e164.spec.ts` (new, 17 cases): punctuation forms, `00`/`011` prefixes,
national + default code, NANP `1` handling both ways, non-NANP trunk `0`, every rejection reason,
length bounds, and **idempotence** (normalising its own output is a no-op). `apps/api/test/pbx/
pbxDto.test.ts` gained 7 cases covering the DID surface and all five caller-ID columns.

---

## Cross-area needed

- **`packages/config`** (not mine): `PLATFORM_SECRET_ENCRYPTION_KEY` should join the central env
  schema so a deployment fails at boot rather than at the first SSO write. It is validated
  package-locally today, following the `PROVISION_SIP_SECRET_KEY` precedent.
- **Deployment**: `PLATFORM_SECRET_ENCRYPTION_KEY` must be set before the first SSO provider write on
  any environment, and `db:encrypt-sso-secrets` run once against each existing database.
  `apps/api/Dockerfile` / the compose files may need the variable threaded through.
- **An organization country-code setting** would let `e164In` accept national input. Deliberately not
  added here: it is a new catalogued org setting plus a form field, i.e. its own change, and
  guessing without it is the failure mode the module exists to avoid.
- **`packages/routing`** (explicitly out of scope, reporting as instructed): `compile.ts` and
  `resolve.ts` compare numbers as opaque strings. Now that every WRITE path is canonical they will
  agree in practice, but the compiler has no assertion that the values it matches on are E.164 — a
  row written before this change, or by a direct SQL edit, still compiles. Recommend `isE164` as a
  compile-time assertion there.

## Verification

| Command                                                              | Result                              |
| -------------------------------------------------------------------- | ----------------------------------- |
| `pnpm --filter @optimiq-voice/db run typecheck`                      | pass                                |
| `pnpm --filter @optimiq-voice/db run test`                           | **111 pass / 0 fail** (8 files)     |
| `pnpm --filter @optimiq-voice/telephony run typecheck`               | pass                                |
| `pnpm --filter @optimiq-voice/telephony run test`                    | **259 pass / 0 fail** (13 files)    |
| `pnpm --filter @optimiq-voice/api run typecheck`                     | pass                                |
| `pnpm --filter @optimiq-voice/api run test`                          | **1374 passing / 0 failing**        |
| `pnpm --filter @optimiq-voice/web run typecheck`                     | pass                                |
| `pnpm exec turbo run typecheck --filter=...telephony --filter=...db` | **23/23 successful** (incl. engine) |
| `pnpm exec oxlint` (my dirs)                                         | 0 findings                          |
| `pnpm exec oxfmt` (my 18 files)                                      | clean                               |

---

## 2. Ray Baum per-device dispatchable location — FIXED (see `FIX-raybaum.md`)

`device.emergency_address_id` (nullable FK → `emergency_address`, `ON DELETE SET NULL`, mirroring
`phone_number`) plus `device.emergency_location_detail`. Migration
`20260909202353_pbx_device_dispatchable_location` — additive only: two nullable `ADD COLUMN`, one
index, one FK. No grants pair needed (grants are table-level here, per the `device_token_hash`
precedent).

Surfaced in three places: the provisioning render (`RenderSnapshot.emergencyAddress`,
`RenderContext.dispatchableLocation`) and the softphone payload — the one endpoint that can show a
user where a 911 call from them lands, since a vendor `.cfg` has nowhere for a street address; the
Kari's Law notification, where `readContext` walks `callerNumber → extension → device_line → device`
and a device's own address outranks the DID's; and a "Dispatchable location" section on the web
device dialog.

Permissions: no new permission. Writing either field needs `numbers.emergency` **on top of**
`devices.write`, enforced in the service rather than the decorator because it tests field _presence_
(an explicit `null` counts — clearing a location is setting one), so a `devices.write`-only holder
can still rename a phone.

Note: the real paths were `apps/api/src/provisioning/devices/**` and
`apps/web/lib/provisioning/schemas.ts`, not the `pbx/devices` paths I named in the brief.

## 4. Reporting — agent stats and call volume — FIXED (see `FIX-reporting.md`)

Added beside `queue-stats`, which is untouched.

- `GET /api/v1/cdr/agent-stats` — `queues.monitor`. Answered, talk time (total/avg/longest), caller
  wait, ring time, wrap-up, plus a per-queue breakdown. Gated on `queues.monitor` and not `cdr.read`
  for the same reason `queue-stats` is: the response names no call, caller or number, and gating it
  on `cdr.read` would hand an agent-performance table the right to read every conversation.
- `GET /api/v1/cdr/call-volume` — `cdr.read`, the **unscoped** grant and the only endpoint on the
  controller whose floor is not `cdr.read.own`, because there is no honest per-person version of "we
  took 400 calls this week".

**Wrap-up is an explicitly-labelled proxy**: nothing on this platform records after-call-work state,
so it is the capped `lead(answered_at) - ended_at` gap between an agent's consecutive answered calls,
with `wrapUpSamples` travelling beside it and the web layer refusing to render a mean below five
samples. Omitting it was the alternative and was rejected because somebody would then compute it
downstream with no cap at all.

Bounded by `limit` + a `truncated` flag rather than a cursor: a keyset cursor over groups whose
contents shift under it is a correctness problem invented for a non-problem.

**Index decision.** call-volume: _no index added_ — `call_legs_organization_started_idx` is exactly
its predicate. agent-stats: one added, `call_legs_queue_agent_idx (organization_id, queue_agent_ref,
started_at DESC) WHERE queue_agent_ref is not null`, because the existing partial queue index does
not key on the agent. Migration `20260909202819_cdr_reporting_indexes`, one plain additive
`CREATE INDEX`; live `EXPLAIN` shows the planner using it with 2 partitions pruned.

The live check caught a bug the unit tests could not: a bound `date_trunc` grain repeated in
`GROUP BY` emits a second placeholder and Postgres rejects the grouping. Fixed with an ordinal
`group by 1` plus a test pinning it.

## 5. Porting and CNAM via Telnyx — FIXED (see `FIX-porting-cnam.md`)

`packages/telnyx`: new `src/resources/porting-orders.ts`
(`create` / `list` / `get` / `findByCustomerReference`); CNAM added to `phone-numbers.ts`
(`getCnamListing` / `updateCnamListing`, plus `cnamListing` on the voice PATCH input). The fake
server gained `/porting_orders` routes and persisted CNAM, so **no live carrier call happens
anywhere** — `TELNYX_API_KEY` was never set and every request goes to the loopback fake.

Two carrier shapes drove the design: `POST /porting_orders` returns a **list** (Telnyx files one
order per losing carrier, so folding them would silently drop numbers), and CNAM's two halves live
on two endpoints, so read and write are each two requests. The create uses `retryable: false` with a
`customerReference` token and a reconciliation read, exactly like `number-orders.ts`.

Routes: `POST /carrier/porting-orders` (`numbers.order`), `GET /carrier/porting-orders[/:id]`
(`numbers.read`), `GET|PATCH /carrier/numbers/:id/cnam` (`numbers.read` / `numbers.write`). No
permission added. `createPortingOrder` deliberately writes **no** `phone_number` row: a port in
flight still routes to the losing carrier, and a row would publish a DID whose calls land elsewhere.

**READ vs INFERRED**: the whole CNAM surface was READ from `reference/telnyx-api.md`. Every porting
shape was **INFERRED** from the public v2 API — the pinned doc does not cover porting — including the
list-shaped create, the 8-value status enum, `support_key` and `activation_settings`. The module
header says so, and the schemas are loose with only `id`/`status` required.

Deviation: **no CNAM field was added to `phone-numbers.dto.ts`.** There is no CNAM column in
`packages/pbx-db`, so the field would be a write with nowhere to land. CNAM is carrier-held state
with one source of truth; a mirrored column needs a migration first.

---

## Consolidated verification (final, whole tree)

| Package                    | typecheck            | test                            |
| -------------------------- | -------------------- | ------------------------------- |
| `@optimiq-voice/db`        | pass                 | **111 pass / 0 fail**           |
| `@optimiq-voice/telephony` | pass                 | **259 pass / 0 fail**           |
| `@optimiq-voice/pbx-db`    | pass                 | **108 pass / 14 skip / 0 fail** |
| `@optimiq-voice/cdr-db`    | pass                 | **75 pass / 0 fail**            |
| `@optimiq-voice/telnyx`    | pass                 | **95 pass / 0 fail**            |
| `@optimiq-voice/api`       | pass (both projects) | **1393 passing / 0 failing**    |
| `@optimiq-voice/web`       | pass                 | **847 pass / 0 fail**           |

- `pnpm --filter @optimiq-voice/web run codegen:check` → _permissions.generated.ts is up to date._
  (No permission was invented in any of the five items.)
- `pnpm exec oxlint` over every directory touched → **0 findings**.
- `pnpm exec oxfmt --check` over the 18 files I changed directly → clean.
- `pnpm exec turbo run typecheck` → **27/29**. The one failure is
  `apps/engine/src/nats/rpc-latency.ts(49,5)`, an **untracked new file in another agent's area**
  (`apps/engine` is off-limits to me) and unrelated to any change here; the file does not import
  anything I touched. The other non-success is its dependent.

## Migrations added (all additive, none applied to any environment but the local stack)

| Package  | Migration                                         | Contents                               |
| -------- | ------------------------------------------------- | -------------------------------------- |
| `pbx-db` | `20260909202353_pbx_device_dispatchable_location` | 2 nullable `ADD COLUMN`, 1 index, 1 FK |
| `cdr-db` | `20260909202819_cdr_reporting_indexes`            | 1 `CREATE INDEX`                       |
| `db`     | _(none — deliberately; see item 1)_               |                                        |

## Follow-ups for other areas

1. **`packages/config`**: add `PLATFORM_SECRET_ENCRYPTION_KEY` to the central env schema.
2. **Deployment**: set that key before the first SSO write; run `db:encrypt-sso-secrets` once per
   database; thread the variable through `apps/api/Dockerfile` and the compose files.
3. **`apps/engine` / `packages/events`**: `call.emergency.dialed` carries no device identifier, so
   the Kari's Law notice resolves the handset by inference. Adding `deviceId` to the payload is the
   real fix.
4. **Emergency-address CRUD**: `emergency_address.validated` is still not a write gate for either
   `phone_number` or `device`. It is carried honestly into the softphone payload and the mail; making
   it a hard precondition is a one-place follow-up.
5. **`apps/web` nav**: `/reports` works by URL but has no nav entry (`lib/routes.ts` /
   `nav-config.ts` were being edited concurrently). Two-line follow-up.
6. **`packages/routing`** (out of scope, reported as instructed): `compile.ts` / `resolve.ts` compare
   numbers as opaque strings with no E.164 assertion. Now that every write path is canonical they
   agree in practice, but a row written by direct SQL still compiles. Recommend `isE164` there.
7. **An organization country-code setting** would let `e164In` accept national input.

## Process note

The reporting agent ran `git stash -u` in this shared worktree to measure a typecheck baseline; the
pop conflicted on `go.work.sum` and was restored to the other agent's newer version. It should not
have happened in a worktree several agents share. I re-verified afterwards that every file in items
1 and 3 is present and correctly wired, and all suites above are green. Nothing was committed,
staged, or left stashed (`git stash list` is empty).
