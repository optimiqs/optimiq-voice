# GAP2026 — recording-compliance

Area owner: recording-compliance. Contract implemented: `RECORDING-CONTRACT.md` (this directory).
Live evidence: `GAP2026-recording-live.md`, artifacts under `<scratchpad>/e2e/artifacts/recording/`.
Nothing committed, staged or stashed.

## What already existed (verified before building)

| Claimed gap                                         | Verdict    | Evidence                                                                                                                                                                            |
| --------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recording policy per extension / queue / conference | **EXISTS** | `packages/routing` `RECORD_POLICIES`; honoured at `plan-walker.ts:3761` (extension), `queue-session.ts:1226` (queue), `plan-walker.ts:4994` (conference)                            |
| Recording pause / resume                            | **EXISTS** | `CallControl.pauseRecording` (`call-control.ts:2762`), HTTP `POST /calls/:id/recording/pause                                                                                        | resume`under`calls.control`, `recordings.pauses` jsonb |
| Retention sweeper for recordings                    | **EXISTS** | `apps/api/src/cdr/recordings/recording-retention-sweeper.service.ts`, org setting `recordings.retentionDays`                                                                        |
| Recording disclosure / consent                      | **ABSENT** | Nothing in the schema, DTOs, catalogue or permission registry; `permissions.ts:354` referred to "whatever the tenant's recording policy plays at the top of the call" in prose only |
| Consent logging on leg / CDR / metadata             | **ABSENT** | —                                                                                                                                                                                   |
| Jurisdiction policy                                 | **ABSENT** | `packages/telephony` has no region catalogue at all                                                                                                                                 |
| GDPR/CCPA erasure                                   | **ABSENT** | Retention purged by age; nothing erased by subject                                                                                                                                  |
| Auto-pause on DTMF                                  | **ABSENT** | Only the manual pause existed                                                                                                                                                       |

So the five briefed items reduce to: build disclosure, consent logging, jurisdiction, erasure and
auto-pause; keep pause/resume and the retention sweeper exactly as they are.

## 1. Recording disclosure

Org policy `none` | `announce` | `announce-and-require-keypress` with a prompt ref, plus a
per-DID and per-inbound-route override.

- Vocabulary: `packages/routing/src/recording-consent.ts` — `RECORDING_CONSENT_POLICIES`,
  `RECORDING_CONSENT_OUTCOMES`, `RECORDING_CONSENT_METHODS`, `RecordingConsentRecord`,
  `DEFAULT_ALL_PARTY_REGIONS`, `isRecordingConsentPolicy`.
- Artifact: `CompiledRecordingPolicy` on `CompiledRoutingSettings.recording?`; the override on
  `InboundDidDefault` and `InboundRule`. All optional — **no `ROUTING_ARTIFACT_VERSION` bump**, an
  artifact compiled before this reads exactly as it did.
- Settings: six new `recordings`-category descriptors (`consentPolicy`, `consentPromptId`,
  `consentAcceptDigit`, `consentDeclineDigit`, `allPartyRegions`, `autoPauseOnDtmf`) in
  `org-settings.catalog.ts`; writes already require `recordings.configure`, reads `settings.read`.
- Loader: `readRecordingSettings` in `snapshot-loader.ts`, its own statement on
  `category='recordings'` (the `sip`/`realm` precedent — two categories in one `byName` map would
  collide). Disabled row = absent; unset = **absent key**, so a tenant that set none of them keeps a
  byte-identical snapshot hash.
- DB: `phone_number` / `inbound_route` gain `recording_consent_policy` (checked) and
  `recording_consent_prompt_id` (FK → `prompt.id`, on delete set null).
- Prompt: a `recording-consent` stem seeded by `system-media.ts` (`SYSTEM_MEDIA_VERSION` → 2), so
  `sound:recording-consent` exists on a stock install exactly like `vm-rec-name`. An operator's own
  file at that key is preserved (`inspect()` classifies it `foreign`).
- Engine: the gate runs in `CallControl.startRecording` **before any tap exists**, so every start
  path — extension policy, queue policy, conference, the record-toggle feature code, the `record`
  verb — goes through one implementation with no second source of truth.
- **The far end**: the announcement plays to `leg.peerMediaChannelId` as well as the recorded leg
  whenever the resolved `parties` name both sides, which is what makes an outbound recorded call
  announce to the person being recorded. See the live report for the ordering defect this exposed
  and its fix.

## 2. Consent logging

- `RecordingConsentRecord` = `{ outcome, method, policy, at, parties, regions?, promptId? }`.
- Recording metadata: `recordings.consent` jsonb, written by `recording-writer.service.ts`.
  Forward-only — a redelivery or a `stopped` that outran its `started` updates
  `where consent is null`, so a value already written is never blanked or rewritten.
- The leg/CDR: `call_legs.recording_consent`, `.recording_consent_method`, `.recording_consent_at`,
  `.recording_consent_regions`. Carried from the engine on channel variables
  (`OPTIMIQ_RECORDING_CONSENT*`) → `cdr-leg.ts` → `cdr.leg.write` → `cdr-leg-mapping.ts`. No check
  constraints on those columns: `call_legs` is append-only and partitioned, and an unrecognised
  future value must reach a row rather than fail a write.
- **A declined consent stops the recording and is still recorded.** `startRecording` refuses naming
  the decline, no object is written, and the consent record still reaches the leg — the whole point
  is that a declined call is provably declined. Proved live.

## 3. Jurisdiction policy

- `apps/engine/src/calls/recording-jurisdiction.ts` — `regionsForNumber(e164)` and
  `requiresAllParty(numbers, allPartyRegions)`. 452 NANP NPAs → `US-XX`/`CA-XX` (+ the broader
  `US`/`CA`), 197 calling codes → ISO 3166-1 alpha-2, `EU` appended for the 27 member states.
  Non-geographic NPAs (toll-free, 900, PCS) return `[]` rather than a guessed `US`. All tables are
  module-level `ReadonlyMap`s built once; every lookup is `Map.get`, no scans.
- A call whose caller id **or** destination lands in a configured region is treated as all-party:
  both sides are announced to, and a policy of `none` is upgraded to `announce` — an all-party
  jurisdiction is exactly the case where silence is the failure.
- Default list: the all-party US states plus `EU` (`DEFAULT_ALL_PARTY_REGIONS`), **editable**.
- Documented in `docs/recording-compliance.md`, which states plainly that the mapping is a
  configurable policy default and **not legal advice**, and that NPA→state is approximate because
  numbers are portable. The settings screen repeats it in three places.

## 4. Erasure (GDPR / CCPA)

`POST /api/v1/erasure/preview` and `POST /api/v1/erasure`, body `{ phoneNumber }` XOR
`{ extension }`, response `{ recordings, voicemailMessages, callLegs, objects }`.
**Permission: `recordings.delete`** on both — nothing added to the registry, so no web codegen was
owed (`codegen:check` passes).

- Preview mutates nothing (the test asserts no `update`/`delete` and no admin-DB touch).
- Apply is **object before row** throughout: recording objects deleted then the row tombstoned
  (`deleted_at`, **row kept**); voicemail objects deleted then the row removed; then the legs.
- CDR PII: only the matching number column is hashed (`sha256:<24 hex>`) — hashing both parties
  would erase a second person's number on a request they did not make, and it is also what makes the
  second apply a no-op with no "already erased" bookkeeping. `from_name`, `sip_call_id`,
  `account_code`, `remote_media_address` nulled, `raw` → `'{}'::jsonb`. **Legs are kept**, so
  billing counts survive.
- Idempotent, org-scoped on every statement, and audited as `recording.erasure` carrying the
  **hash**, never the plaintext — a ledger row naming someone who asked to be forgotten would be the
  erasure failing at the last step.
- Cross-database wall respected: voicemail (`pbx-db`) and the audit log are reached through two new
  CDR-declared ports implemented on the PBX side, no join spans the two databases.
- UI: a fenced "Erase a person's data" panel on the recordings settings screen, gated on
  `recordings.delete`, preview → re-type the subject → confirm, stating what is destroyed and what
  survives.

## 5. PCI — auto-pause on DTMF

Pause/resume is untouched. Added under it: a per-extension / per-queue / org-default
"auto-pause on DTMF" policy.

- `extension.record_auto_pause_on_dtmf` and `queue.record_auto_pause_on_dtmf` (default false), the
  org default `recordings.autoPauseOnDtmf`, compiled onto `ExtensionPlanNode`, `QueuePlanNode` and
  `ExtensionIndexEntry`.
- Engine: `channel-orchestrator.service.ts` `onDtmf` pauses the running recorder on the first digit
  and arms a quiet-window timer (`recordingAutoResumeMs`, 3 000 ms) that resumes it; every further
  digit refreshes the window. Timers are cleared on leg teardown, on an explicit stop and on
  shutdown — a timer that resumed a recording on a dead leg is the failure mode, and there is no
  unbounded map growth.
- Resolution order: explicit request flag → `extensionsByNumber[destination]` → org default → false.
- Off by default: auto-pausing is wrong for estates that record IVR navigation deliberately.

## Live proof

Full evidence in `GAP2026-recording-live.md`. Summary:

| Proof                                                     | Verdict                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Declined keypress stops recording (and accept records it) | **PASS**                                                                                                                   |
| Erasure preview / apply / idempotent / 403                | **PASS** (after two defects found and fixed)                                                                               |
| DTMF auto-pause yields a silence gap                      | **PASS** — `pauses [{4940,15740}]`, 106 consecutive 100 ms windows at RMS exactly 0.000000, `0.72` before and `0.74` after |
| Outbound recorded call hears the announcement             | **PASS**, after two rounds of real defects — see below                                                                     |

### Proof 1: what the live run actually found

The first run was a **PARTIAL FAIL**, and the failure was the exact one the feature exists to
prevent: mediad logged `playedMs 0` / `WebRTC media is not connected` for the far-end playback, the
callee's inbound energy was `0.000000` across all 23 windows, and the consent record nevertheless
said `parties: ["caller","callee"]`. **A call recorded on the strength of a disclosure nobody
heard.** Three defects, all in this area, all fixed:

1. **The announcement played at bridge time**, before the party's leg was even answered. Fixed with
   a readiness gate on the `answered` signal the orchestrator already publishes
   (`consentPeerReadyTimeoutMs`, 2 s); a party that never gets there is left out of `parties`, and
   if no party is left the recording is refused.
2. **The engine could not tell whether a prompt played.** `mediad` has always published
   `playback.finished` with `playedMs` — `apps/engine/src/media/mediad-event-mapping.ts` simply
   dropped it. Now mapped, with a `MediaPlaybackFinishedEvent` union member, an ARI equivalent
   mapped in `ari-mapping.ts`, and a `PlaybackSignalBus` the orchestrator republishes on.
   `announceConsent` counts a party as announced-to **only on `playedMs > 0`**. No `packages/events`
   change was needed — the wire schema already carried the fields.
3. **Frames written into a transport with no peer are not queued anywhere**, so waiting for the
   report was necessary but not sufficient — the first attempt is genuinely lost while the browser's
   DTLS comes up. The gate now replays until the media plane reports delivery
   (`consentPlaybackTimeoutMs` 8 s, `consentPlaybackRetryMs` 250 ms). Still event-driven: it stops on
   the media plane's word, never on a clock, and an RTP endpoint pays nothing.

An interim fix used a fixed 1 500 ms sleep (`consentMediaSettleMs`) on the path of every recorded
call. **That is gone** — `grep` across `apps/`, `packages/` and `docs/` returns nothing.

Far-end inbound energy, both softphone tones muted, 23 × 150 ms windows:

| Build                | Mechanism                | mediad             | Far-end energy                                                   |
| -------------------- | ------------------------ | ------------------ | ---------------------------------------------------------------- |
| original             | play at bridge           | `playedMs 0`       | **0.000000**                                                     |
| readiness gate only  | wait for `answered`      | `playedMs 0`       | **0.000000**                                                     |
| interim              | fixed 1 509 ms sleep     | clean              | 0.100104                                                         |
| delivery report only | no sleep, no retry       | `playedMs 0`       | **0.000000**, but `parties: ["caller"]` — the record went honest |
| **final**            | delivery report + replay | clean on attempt 5 | **0.110049**                                                     |

Bridge → recording start went from 1 512 ms of constant to **2 152 ms**, of which 1 044 ms is the
prompt actually playing and ~1 108 ms is that particular far end's own DTLS handshake. The delay is
now the prompt, not a constant. Reproduced on a second full run 44 s later.

Three consent rows in `optimiq_cdr` tell the whole story: the old build claiming
`["caller","callee"]` on a call the callee provably did not hear, the delivery-only build honestly
recording `["caller"]` on the same failure, and the final build recording `["caller","callee"]` with
the energy to back it.

**What "announced" can and cannot mean.** On mediad it now means the media plane reported it played
audio to that party — which is as far as any switch can go. Nobody can prove a human listened, and
`docs/recording-compliance.md` says so. On an ARI deployment the claim is weaker: ARI's
`PlaybackFinished` carries no duration, so `playedMs` is absent and `announced` falls back to "the
playback ended without failing". The field is optional precisely so a reader can tell "delivered
nothing" from "this driver does not measure delivery".

## Defects found in other areas (NOT fixed — cross-area)

1. **`packages/cdr-db/src/retention.ts:111`** — `purgedRecordingSoftDeleteQuery` emits
   `any((...)::uuid[])`, which Postgres rejects with `42846` for two or more ids. It also breaks
   `recording-retention-sweeper.service.ts:191`, i.e. **the recording retention sweep cannot purge
   more than one recording per organization per batch**. Worked around inside
   `apps/api/src/cdr/erasure/` with a correct statement; the shared helper still needs fixing.
2. **`apps/engine/src/queue/queue-session.ts`** — the per-queue `recordAutoPauseOnDtmf` flag is
   compiled but not honoured, because the queue owns its own `startRecording` call path. Exact
   one-line change needed where the queue starts the recording:
   `autoPauseOnDtmf: node.recordAutoPauseOnDtmf ?? artifact.settings.recording?.autoPauseOnDtmf ?? false`
   in the `StartRecordingRequest` (and ideally `consent`, resolved the way the orchestrator's
   `recordingRequestFor` does).
3. **`outbound_route.recordEnabled` and `ConferencePlanNode.recordEnabled` are accepted by the API
   and read by nothing in the engine.** Two live runs with the flag on recorded the inbound leg
   only. Consequence for this area: there is no live path that puts the recorder on an outbound
   leg, so the outbound-direction consent rule is unit-proved (5 cases) rather than live-proved.
   This is the same class of bug as the extension `record_policy` one closed in an earlier pass.
4. **Stale comments now wrong.** `apps/engine/src/queue/queue-session.ts:141` and
   `apps/engine/src/verbs/verb-executor.ts:240` both still say `MediaEvent` has no playback member.
   It does now. `apps/engine/src/media/mediad-media.port.ts` (mine) was corrected; those two are
   other agents' files.
5. **The playback signal bus is separate from `CallSignalBus`** only because `CallSignal`'s union
   lives in `apps/engine/src/routing/**`, outside this area. Folding `PlaybackSignal` into
   `CallSignal` would be a ~15-line additive merge if the routing owner wants it.
6. `packages/events/src/validate.ts:208` and the `webhookSelectors` `messaging`-family test are
   other packs' in-flight work; both were failing before and independently of this area.

## Additional scope from the coordinator (delivered)

- **Audit the reads.** `recording.download-url`, `recording.play`, `voicemail-message.play-url`,
  `voicemail-message.play`, `call-recording.pause`, `call-recording.resume` — actor, org, object, ip
  and user-agent. A signed-token open records a `system` actor and the token subject, never a
  fabricated user; a refused pause or forged token writes no row. Best-effort throughout: a ledger
  outage never costs a listener their audio. (Note: `recordings.service.ts::delete` was only
  logging, not auditing — the pattern copied is the retention sweeper's.)
- **Voicemail retention.** Org setting `recordings.voicemailRetentionDays` (same vocabulary and
  bounds as `retentionDays`, `0` = keep for ever) plus
  `voicemail-retention-sweeper.service.ts` — object before row, per-organization, audited, MWI
  republished.
- **Audit-log purge.** `AUDIT_LOG_RETENTION_DAYS`, default 400. Platform env, never a tenant
  setting: a tenant able to set it could shorten the evidence of its own administrators' actions.
- **CDR leg retention default.** `CDR_LEG_RETENTION_MONTHS` 0 → **24**. A never-expiring default
  quietly makes every deployment an indefinite store of call metadata, which is the opposite of
  data minimisation; 24 months covers the billing-dispute and traceback windows, `0` still means
  keep-indefinitely for a deployment that opts in. `CDR_RETENTION_DRY_RUN` still defaults true, so
  no deployment destroys anything on upgrade.
- Proved live with synthetic old rows: voicemail sweep purged 1 of 2, audit purge 1 of 2, CDR leg
  sweep dry-run planned a 2024-10-01 cutoff. Every row created was cleaned up. The CDR dry run was
  deliberately NOT cleared — the leg sweep is `DROP TABLE` on a shared monthly partition and would
  have destroyed every other tenant's legs on this stack.

## Migrations

Applied to the live DB under the `MIGRATION-LOCK-<package>` protocol, purely additive
(`ADD COLUMN` / `ADD CONSTRAINT` only, no drops, no rewrites):

- `packages/pbx-db/drizzle/20260910045838_pbx_recording_consent`
- `packages/cdr-db/drizzle/20260910045858_cdr_recording_consent`

No new NATS stream or KV bucket — only optional fields on existing event payloads
(`channel.record.started.consent`, four nullish `recordingConsent*` on `cdr.leg.write`) — so no
`config/nats.conf` grants were owed and none were changed.

## Verification

| Package                  | typecheck                                                        | tests                                                                                               |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@optimiq-voice/routing` | clean                                                            | **965 pass, 0 fail** (24 files)                                                                     |
| `@optimiq-voice/events`  | clean                                                            | **437 pass, 0 fail** (449 incl. skips, 13 files)                                                    |
| `@optimiq-voice/pbx-db`  | clean                                                            | **117 pass, 0 fail** (138 incl. skips, 5 files)                                                     |
| `@optimiq-voice/cdr-db`  | clean                                                            | **79 pass, 0 fail** (114 incl. skips, 7 files)                                                      |
| `@optimiq-voice/engine`  | clean                                                            | **2035 pass, 0 fail** (2047 incl. skips, 87 files)                                                  |
| `@optimiq-voice/api`     | one error, `packages/events/src/validate.ts:208`, another pack's | **1761 passing, 1 failing** — the failure is `webhookSelectors`' `messaging` family, another pack's |
| `@optimiq-voice/web`     | clean                                                            | **1043 pass, 0 fail** (52 files); `codegen:check` passes                                            |

`oxlint` and `oxfmt` clean across every directory touched.

## Stack state at hand-off

Every live proof in this area completed against a healthy stack and each restart this area performed
(engine ×6, api ×2 — all logged in `STACK.md`) was verified 200 afterwards. **At hand-off the whole
stack is DOWN again** — api, engine, sipd, mediad, web all `000`, pid files still present. sipd,
mediad, NATS and Postgres were never touched by this area, so this is not ours; flagging it rather
than running a bare `up.sh`, which the coordinator's rule forbids.
