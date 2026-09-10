# FIX — STIR/SHAKEN onto the CDR, and `deviceId` onto `call.emergency.dialed`

Nothing committed, staged or stashed. No service restarted. No migration run.

## JOB A — attestation reaches the CDR

1. `apps/engine/src/calls/channel-orchestrator.service.ts` — new `OPTIMIQ_SIP_ATTESTATION` /
   `OPTIMIQ_SIP_VERSTAT` / `OPTIMIQ_SIP_ORIGID` / `OPTIMIQ_DEVICE_ID` consts beside the auth-pin
   family; `invitedChannelSnapshot` stamps only the keys the request actually carried.
   `writeCdr` gained `...attestationOf(...)` beside `...authorizationOf(...)`.
2. `apps/engine/src/calls/cdr-leg.ts` — `attestationOf(variables)`, mirroring `authorizationOf`'s
   shape and defensiveness but deliberately NOT all-or-nothing (a `verstat` with no level is the
   useful half; documented in the function header). Level outside A/B/C dropped. Fields added to
   `CdrLegInput` and spread into `buildCdrLegWrite`.
   **Bug found and fixed:** `buildCdrLegWrite` never forwarded `authorizationOf`'s result — the
   call site spread it into `CdrLegInput`, which had no such fields, so every gated outbound call
   reported no authorisation at all. `authPinOrdinal`/`authPinLabel` now on the input and the
   output, with a regression test.
3. `packages/events/src/schemas/cdr-events.ts` — `sipAttestation` (enum A/B/C), `sipVerstat` (≤64),
   `sipOrigId` (≤128), all nullish, with the "visibility only, never an authorisation" rationale.
   Codegen run; **byte-identical over two runs** (shasum of the whole `packages/events-go` tree).
4. `packages/cdr-db/src/schema/call-leg-schema.ts` — `sip_attestation`, `sip_verstat`,
   `sip_orig_id`, nullable text, no index. Migration generated with the repo's `db:generate` and
   renamed to `drizzle/20260909211645_cdr_sip_attestation/`, with the hand-edited header copied
   from `20260812153651_cdr_auth_pin` (partitioned DDL recursion, metadata-only ADD COLUMNs,
   nothing backfilled and nothing could be, the JWS deliberately not stored). `db:check` clean.
   `cdr-schema.spec.ts`'s column-count band widened 45 → 50 (47 columns now).
5. `apps/api/src/cdr/writer/cdr-leg-mapping.ts` — three names on `MAPPED_COLUMNS` (so they stay out
   of `raw`), three fields on the row interface, and an `attestation` block following the
   `authPinOrdinal` style: an unrecognised level is dropped and recorded as a coercion; verstat and
   origid are truncated to 64/128 rather than refused.
6. `apps/api/src/cdr/query/cdr.repository.ts` — all three on `LEG_LIST_COLUMNS`, which
   `LEG_DETAIL_COLUMNS` spreads, so they surface in list AND detail. The service returns rows
   unmapped, so no DTO change was needed.

## JOB B — `deviceId`

1. `packages/events/src/schemas/call-events.ts` — `callEmergencyDialedDataSchema.deviceId`
   (optional uuid): the registered device the call was placed FROM; absent means the consumer falls
   back to inference, and absence is never an error.
2. `packages/events/src/schemas/rpc.ts` — `sipInviteRequestSchema.deviceId` (optional uuid), one
   small Edit beside `orgId`, anchor re-read first. Identity, never authorisation.
3. `apps/engine` — `OPTIMIQ_DEVICE_ID` stamped in `invitedChannelSnapshot`; `walkerChannelFor`
   exposes it. **In `apps/engine/src/routing` (another agent's area) exactly two additive things:**
   an optional `deviceId?: string` on the `WalkerChannel` port (the port is narrow and carries no
   `variables`, so a field was unavoidable) and the single spread line in `notifyEmergency`.
   Nothing else in that file touched. Two cases added to the emergency block of
   `plan-walker.spec.ts` (named / omitted), plus an optional `deviceId` on the spec harness.
4. `apps/api/src/pbx/emergency-addresses/` — consumer forwards `data.deviceId`;
   `EmergencyDialedNotice.deviceId`; `readContext` now resolves the handset from the EVENT when it
   named one (single-row lookup, no ambiguity claimed) and falls back to the
   `callerNumber → extension → device_line → device` walk when it did not, or when the named device
   no longer exists. Two cases in `apps/api/test/pbx/emergencyNotification.test.ts`; the fake
   transaction's ordering comment updated to state both shapes honestly.

## CROSS-AREA (apps/sipd — not mine, one line)

In `apps/sipd/internal/invite/client.go`, where the admission request is built, carry the device id
the credential reply already returned onto the INVITE RPC — the same place `attestation` is mapped:

    req.DeviceID = cred.DeviceID   // sipCredentialResponseSchema.deviceId → sipInviteRequestSchema.deviceId

Only for `AuthenticationDigest` (a trunk INVITE resolves no credential and must send none). Until
it lands, `deviceId` is absent on every INVITE and the API consumer takes the inference path, which
is exactly the documented fallback — nothing regresses.

## Verification (exact)

| Command                                               | Result                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events typecheck`                                    | pass                                                                                                                                                                                                                                            |
| `events test`                                         | **400 pass / 12 skip / 0 fail** (412 across 13 files)                                                                                                                                                                                           |
| `events codegen` ×2                                   | **byte-identical tree** (tree shasum equal; `git status` unchanged)                                                                                                                                                                             |
| `cdr-db typecheck`                                    | pass                                                                                                                                                                                                                                            |
| `cdr-db test`                                         | **75 pass / 35 skip / 0 fail** (110 across 7 files)                                                                                                                                                                                             |
| `cdr-db db:check`                                     | "Everything's fine"                                                                                                                                                                                                                             |
| `api typecheck`                                       | **1 error, not mine** — `packages/routing/src/e164-ingest.ts(65,37)`, a concurrent agent's edit                                                                                                                                                 |
| `api test`                                            | **1400 passing / 1 failing** — the failure is `test/pbx/orgSettings.test.ts` "only catalogues routing names the compiler actually reads" (`defaultCallingCode`), a file and catalogue another agent is editing. All 7 of my new API cases pass. |
| `engine typecheck`                                    | pass, clean                                                                                                                                                                                                                                     |
| `engine bun test cdr-leg.spec.ts plan-walker.spec.ts` | **199 pass / 0 fail** (370 expects)                                                                                                                                                                                                             |
| `turbo typecheck --filter=...events`                  | **15 successful, 16 total** — the one failure is `api`, same routing error above                                                                                                                                                                |
| `oxlint` (16 files)                                   | 0 findings                                                                                                                                                                                                                                      |
| `oxfmt` (16 files)                                    | clean                                                                                                                                                                                                                                           |

## Skipped

Nothing in the brief. The web CDR surface (`apps/web/app/(app)/cdr/_components/call-detail.tsx`)
now receives the three fields and does not render them — out of area and not asked for.
