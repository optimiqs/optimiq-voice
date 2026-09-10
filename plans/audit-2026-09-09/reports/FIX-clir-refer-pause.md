# FIX — CLIR end to end, in-dialog REFER authorisation, recording pause/resume surface

Closes `E2E-final2.md` rows 3, 5b and 15 (§3 items 6, 3 and 8). Nothing committed, staged or
stashed; no service restarted. `packages/events` / `packages/events-go` are byte-identical to the
baseline I took at the start, so no codegen run was owed.

---

## 1. CLIR end to end — the middle that never existed

Both edges were already right: sipd's `internal/invite/originate.go` emits the anonymous From +
`Privacy: id` + real PAI, and `SplitPlaneMediaPort` carries `callerIdPresentation`. Nothing between
a tenant and that flag could set it. Five layers were added.

### pbx-db

`packages/pbx-db/src/schema/extensions-schema.ts` — `CALLER_ID_PRESENTATIONS` tuple and
`extension.outbound_caller_id_presentation text not null default 'allowed'` with
`extension_outbound_caller_id_presentation_check`, mirroring the `toll_class` enum style. Migration
generated with `pnpm run db:generate` →
`drizzle/20260909235331_pbx_extension_caller_id_presentation/` (2 statements + snapshot). Additive,
defaulted, so an unmigrated reader is unaffected. `features-schema.ts` gained the two new
`FEATURE_CODE_ACTIONS`; `schema.spec.ts` pins the new tuple.

**Skipped, deliberately:** the org-wide `org_settings` default. It needs a second column, an entry in
`org-settings.catalog.ts` (another agent is editing that file right now), a
`CompiledRoutingSettings` field and a second precedence rung in `resolve.ts`. Extension-level only,
which is what the failing row needed.

### packages/routing

- `snapshot.ts` — `CALLER_ID_PRESENTATIONS` / `CallerIdPresentation`,
  `ExtensionInput.outboundCallerIdPresentation`, the two actions.
- `artifact.ts` — `ExtensionIndexEntry.outboundCallerIdPresentation?: "allowed" | "restricted"`,
  optional and additive: an old reader ignores it, and the artifact carries no key at all for the
  common case because
- `compile.ts` projects it **only** when the row says `restricted`.
- `feature-codes.ts` — `*67` (restrict) and `*82` (allow) seeded in `DEFAULT_FEATURE_CODES`, both
  with `argumentMode: "required"`.
- `resolve.ts` — `ResolvedRoute.callerIdPresentation`, taken from the caller's extension on the
  outbound-route path only.

**Feature-code shape, and why.** Two prefix actions with `argumentMode: "required"` —
`*67<destination>` / `*82<destination>`. Nothing was invented: prefix codes already exist (`**<ext>`,
`*80`, `*31`), and `required` is exactly "the digits after the code are the argument". It also makes
`matchFeatureCode` reject a bare `*67`, which would otherwise run a presentation change with no call
to apply it to. `*82` coexists with the `*8` group-pickup code because that one is `none`-mode and
therefore matched exactly, with longest-code-first breaking the tie — asserted in the spec.

**Diagnostics:** no `diagnostics.ts` change was needed. `featureCodeIssues` + `compileFeatureCodes`
already raise `conflicting-feature-code` generically for duplicate and prefix collisions; the new
pair is asserted clean against the seeded catalogue.

### engine plan-walker (`apps/engine/src/routing/plan-walker.ts`)

`WalkInput.callerIdPresentation` and `DialAttempt.callerIdPresentation`; `trunkDialNode` sets it on
the attempt and `originate()` passes it to `media.originate`. A new `callerIdPresentationCode`
handler for the two actions stamps `CLIR_VARIABLE` (`OPTIMIQ_CLIR`) on the A-leg via
`media.setVariable`, then re-enters routing through `control.dial` — that is what makes the per-call
override beat the setting, because `SplitPlaneMediaPort` already ranks the originating leg's
variable above `OriginateRequest.callerIdPresentation`. A failed stamp aborts `*67` (presenting a
number the caller just asked to withhold is the harm) but not `*82`. `dialThroughControl` was
extracted and shared with `redialCode` rather than copying its switch.

Two deliberate exclusions: the **emergency** path never carries presentation (the ELIN must be
visible to a dispatcher), and **follow-me off-net hops** do not either — that leg presents the
original caller's identity, not the forwarding extension's.

`FIX-clir.md` cross-area item 5 (the orchestrator one-liner at
`channel-orchestrator.service.ts:4517`) had already landed from another agent; the walker half is
now done, so the click-to-call and the softphone paths both carry it.

### API

- `pbx/extensions/extensions.dto.ts` — `outboundCallerIdPresentation: z.enum(CALLER_ID_PRESENTATIONS).optional()`
  (optional, not nullish: the column is NOT NULL with a default). The response DTO needed no change —
  `EXTENSION_RESOURCE` returns every column minus `secretColumns`.
- `pbx/feature-codes/feature-codes.dto.ts` — both actions in `FEATURE_CODE_PARAM_SCHEMAS` (noParams)
  and `FEATURE_CODE_PARAM_FIELDS` (`[]`); both records are exhaustive-by-construction, so this was
  forced by the compiler.
- `pbx/routing/snapshot-loader.ts:216` — **the line without which the whole chain stays dead**:
  `outboundCallerIdPresentation: row.outboundCallerIdPresentation,` in the extension projection. The
  loader already does a full-row `select()`, so no query change. (Applied by me after the layer
  agent flagged it as outside its grant.)

**`.own` scope:** presentation is **admin-only**, not self-editable. The brief said it must sit in
whatever `.own` scope governs `outboundCallerIdNumber` — and that field is _not_ in
`SELF_EDITABLE_EXTENSION_FIELDS` (which is forwarding / DND / follow-me only). Matching it therefore
means admin-only. Flagging it in case self-service was actually intended.

### Web

`lib/pbx/contracts.ts` (`CALLER_ID_PRESENTATIONS`, `ExtensionRow.outboundCallerIdPresentation`, the
two actions — its `contracts.spec.ts` pins this list against pbx-db, so it was forced),
`lib/pbx/schemas.ts` (enum on the extension form schema), and `extension-dialog.tsx`: a `SelectField`
"Outbound caller ID" (Show my number / Withhold my number) beside the outbound number, matching the
`tollClass` / `recordPolicy` convention.

---

## 2. Blind transfer by the party who ANSWERED — fixed in sipd, and belt-and-braces on the wire

**The bug (row 5b, proved on the wire).** On an _incoming_ JsSIP session the REFER's From is the
dialog's local URI — the anonymous instance URI, `sip:mdokeqt0@bnttdi537va5.invalid;transport=ws`.
`transfer/handler.go` did `addressOfRecord(from.Address)`, derived user `mdokeqt0`, digest-challenged
it, and no such credential exists → 401 → "The transfer to 1202 was refused."

**The fix — authorise by dialog membership, per RFC 3261 §12.2.**

- `internal/dialog/dialog.go` — `Dialog.AccountAOR` / `Options.AccountAOR`: the address of record of
  the registered account at the far end of the dialog. Empty for a trunk leg or a bare URI.
- `internal/dialog/store.go` — `Membership{LegID, OrgID, AccountAOR}` and
  `(*Store).MatchEstablished(req)`. It resolves `identityOfIncoming(req)` and looks up **only**
  `byIdentity` (the full Call-ID + local-tag + remote-tag triple), never the early index, and
  requires `state.Answered()`. Values are copied out under `s.mu` so no `*Dialog` escapes to a
  non-owning goroutine — the same discipline as `FindReplaced`.
- `internal/invite/handler.go` and `originate.go` — the AoR is carried onto every dialog:
  `intent.From.AOR` on an inbound digest INVITE (UAS), and a new `dialTarget.aor` (set in
  `resolveAOR`) on an outbound one (UAC). Both empty for trunks.
- `internal/transfer/handler.go` — a `Dialogs` option/interface (`*dialog.Store` satisfies it) and
  `identify()`, replacing the unconditional `authorize()`.

**The exact predicate.** Authorise by membership iff Call-ID **and both** dialog tags match a dialog
in this instance's table (`byIdentity` only) **and** it is `Answered()` **and** it carries a
non-empty `AccountAOR` **and** `creds.Lookup(lower(aorHost), aorUser)` succeeds **and**
`credential.OrgID == dialog.OrgID`. Anything else falls through to the existing digest path, byte for
byte.

**Security argument.** An in-dialog request's From is the dialog's own local URI and asserts no
identity at all, which is precisely why digest on it is the wrong test. Both dialog tags are
unguessable secrets shared only with the dialog's two peers, so matching both _is_ the proof of
participation; a guessed Call-ID alone reaches nothing, which is why the early index is deliberately
excluded. The org cross-check stops a credential store answering for another tenant. Crucially the
acting identity — `OrgID`, `ReferredBy.AOR/Username/ExtensionID/DeviceID`, and the AoR fed to the
`isRegistered` binding check — comes from the **dialog's** credential, never from the REFER's From;
`requestFor` was untouched, so no downstream path can see the header identity. This **unifies rather
than adds**: BYE / re-INVITE / UPDATE / ACK / CANCEL already authorise exactly this way
(`invite/handler.go` uses `MatchRequest` with no digest).

`cmd/sipd/main.go` now builds the dialog store before the handlers and passes it to
`newTransferHandler`.

**The web half — fixed in sipd, because JsSIP cannot be coerced.** `buildOriginateInvite` was putting
the registered _contact_ URI in `To`. RFC 3261 §8.1.1.2 makes `To` the logical recipient (the AoR);
the Request-URI is the contact. It now sends `To: <sip:1203@realm>` while still dialling the contact
— and JsSIP sets a UAS dialog's `_local_uri` from that `To` (`Dialog.js:47`), so the answering
party's REFER now carries the extension AoR on the wire too. So both halves are closed.

JsSIP itself genuinely cannot be configured, evidence from `jssip@3.13.8`: `ReferSubscriber.sendRefer`
→ `RTCSession.sendRequest` → `Dialog.sendRequest` → `Dialog._createRequest` (`lib/Dialog.js:166`)
hardcodes `from_uri: this._local_uri` with no option threaded through; `OutgoingRequest` sets the
From header in its constructor (`lib/SIPMessage.js:69-70`) and `extraHeaders` are _appended_ at
serialisation, so a `From:` there yields a duplicate header, not an override. Only private-field
mutation of `_dialog._local_uri` would work, which is not worth the coupling. No adapter code change;
two stale doc comments were corrected (`jssip-adapter.ts` said sipd answers 403 to an unauthenticated
REFER — it is 401; `transfer.ts` said "digest-authenticated"). No new web spec, because no new pure
logic was added.

**Tests.** `internal/dialog/store_test.go`: `TestMatchEstablishedAuthorisesOnTheFullTriple` (with
wrong-remote-tag and wrong-local-tag negatives), `TestMatchEstablishedRefusesADialogThatIsNotAnswered`
(unanswered, and after BYE). `internal/transfer/handler_test.go`:
`TestReferFromTheAnsweringPartyIsAuthorisedByItsDialog` — the row-5b orientation exactly: anonymous
instance-URI From, no Authorization → **202**, and the RPC carries the _dialog's_ org / AoR /
username / extensionId / deviceId; plus `TestReferClaimingADialogWithTheWrongTagIsChallenged` (401,
nothing reaches the broker), `TestReferOutOfDialogFromAnUnknownIdentityIsStillChallenged` (401), and
`TestReferOnTheDigestPathIsUnchangedByTheDialogTable`. `internal/invite/originate_internal_test.go`:
two tests pinning the `To`-is-the-AoR / Request-URI-is-the-contact split.

---

## 3. Recording pause/resume — a reachable surface

| Route                                     | Permission      |
| ----------------------------------------- | --------------- |
| `POST /api/v1/calls/:id/recording/pause`  | `calls.control` |
| `POST /api/v1/calls/:id/recording/resume` | `calls.control` |

**Permission, and why not `recordings.write`.** No such permission exists. The catalog's
`recordings.*` block is `read / read.own / download / delete / configure` — all powers over
_artefacts_ or _policy_, none over a live call. `calls.control` is the registry's grant for taking
control of a live call from outside the platform, is what `session-gateway.ts` already gates the
identical verb channel with (`SESSION_PERMISSION = "calls.control"`), and its catalog description
already reads "…recording, dialling and hanging up". Minting a synonym for a surface it already
describes would have spent the permission ceiling on documentation. No `.own` variant applies — no
grant on `calls` is user-scoped. **No permission catalog change, therefore no codegen change**
(`codegen:check` run anyway: up to date).

Both routes return 200 with a strict empty body (`emptyCallControlDto`), take the org from the
session only, and share one service method `CallRecordingService.setPaused(session, callId, paused)`.
Two paths as briefed, one implementation.

**How the verb reaches the engine.** Via the existing session-verb path, not a new subject. The
obstacle: the engine authorises a verb against the session id it minted
(`application-sessions.ts:246` refuses `unknown-leg` for any leg no live session holds), and the API
had no leg→session index at all. New `ControlledCalls` (`apps/api/src/pbx/calls/controlled-calls.ts`):
a replica-local map keyed `<org>/<callId>` whose entries carry a **closure** over
`SessionHub.sendVerb` bound to that session's own identifiers. `SessionGateway.onAnnounce` registers,
`endSession` releases. The closure keeps the session id on the socket (a route that could read it
could address a call it was never given) and avoids a `SessionModule → PbxModule` import cycle.
Tenancy is the lookup itself: another org's call id is indistinguishable from one that never existed.

`apps/api/src/session/session-gateway.ts` was edited — a read-mostly area, but strictly required: it
is the only place the session id exists.

**Reach limitation, stated plainly.** Only a call a programmable session is driving can be commanded.
A softphone call has no session and gets `404 CALL_NOT_CONTROLLABLE`. Closing that needs an engine
change — see cross-area.

**Web.** `lib/softphone/recording.ts` (new, pure): `recordingReducer`, `canPauseRecording` /
`canResumeRecording`, `isRecordingControlVisible`, labels — with `paused` entered **only** on the
engine's confirmation, because an optimistic pause would promise an agent a card number is safe on an
unacknowledged request; a failure keeps the prior status. `lib/softphone/recording-client.ts` does the
two POSTs. `softphone-context.tsx` gains `recording` / `dispatchRecording` / `pauseRecording` /
`resumeRecording`, cleared when the call goes idle. `softphone-dialer.tsx` gains `RecordingControls`
— a pulsing dot, "Recording" / "Recording paused", and a pause/resume button in the active-call panel
above `TransferControls`, **hidden rather than disabled** when nothing is recording (the `Park on …`
precedent).

**Queue supervisor panel: no recording indicator exists.** `queue-detail.tsx`,
`queue-agents-panel.tsx` and `agent-console.tsx` carry no live-recording state; the only "recording"
in the queues area is `queue-dialog.tsx`'s _policy_ fields. Nothing was invented.

**Tests.** `apps/api/test/pbx/callRecordingControl.test.ts` (13): decorator metadata on both handlers;
a caller holding all four `recordings.*` grants and not `calls.control` refused by the real guard; a
`calls.control` caller admitted; verb dispatch asserting `pauseRecord`/`resumeRecord` on the session's
leg; cross-tenant and unknown-call both `CALL_NOT_CONTROLLABLE` with nothing sent to the engine; all
seven refusal reasons mapped to 409/501/503; registry release idempotence; DTO strictness. One new
case in `apps/api/test/session/sessionGateway.test.ts` proving the registry is populated for the
session's life and empty after. `apps/web/lib/softphone/recording.spec.ts` (13).

---

## Cross-area needed

1. **engine — recording pause for a softphone call.** A leg-scoped recording control the control
   plane can address without an application session: either a new `rpc.engine.v1.call-control`
   (org + callId + legId, resolved against the `channels` bucket, which already carries
   `variables.OPTIMIQ_ENGINE_INSTANCE_ID`), or an explicit escape in `application-sessions.execute`
   for control-plane-originated recording verbs. Until then the new routes reach only
   application-driven calls.
2. **web/telephony — nothing tells the browser a call is being recorded**, or its `callId`.
   `packages/telephony`'s `CHANNEL_FLAGS` has no `recording` flag and no call event announces one.
   One additive flag on the channel snapshot (or a `call.recording.started/stopped` event) plus the
   softphone learning its own `callId` lights the control up; the reducer already consumes exactly
   `RECORDING_STARTED { callId }` / `RECORDING_STOPPED`.
3. **`config/nats.conf` HUP reload** for the `rpc.media.v1.pause-recording` grants — still
   outstanding from `FIX-engine-features.md` §3, not done here (no service restarted).
4. **org-wide CLIR default** in `org_settings` + `CompiledRoutingSettings` + a second precedence rung
   in `resolve.ts`, if an org-level default is wanted. Deliberately skipped.
5. **Decision needed:** whether `outboundCallerIdPresentation` should be self-service. It is
   admin-only today, matching `outboundCallerIdNumber`.

## Live re-run owed

- **Row 3 (CLIR restricted)** — an extension set to `restricted` dialling a trunk, and a `*67` prefix
  dial, both checked against the fake carrier for anonymous From + `Privacy: id` + real PAI. Needs
  the migration applied and engine/api restarted.
- **Row 5b (answering-party transfer)** — sipd rebuild + restart. One thing to watch: `apps/engine`
  refuses a transfer it thinks the referrer is not on (`not_permitted`). The referrer identity it now
  receives in the answering orientation is the correct extension, so that check should pass, but it
  has not been observed live.
- **Row 15 (pause/resume)** — reachable now only for an application-driven call; a softphone call
  still needs cross-area 1.

---

## Verification (exact counts, run by me at the end over the whole result)

| Command                                                                | Result                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/routing run typecheck`                   | pass, 0 errors                                                                                                                                    |
| `pnpm --filter @optimiq-voice/routing run test`                        | **922 pass, 0 fail**, 2181 expect(), 23 files                                                                                                     |
| `pnpm exec turbo run typecheck --filter=...routing`                    | 15/17 ok at the time; the one failure was a concurrent agent's `channel-orchestrator.spec.ts` and is **gone** in the final engine typecheck below |
| `pnpm --filter @optimiq-voice/pbx-db run typecheck` / `test` / `build` | pass / **112 pass, 14 skip, 0 fail** / pass                                                                                                       |
| `pnpm --filter @optimiq-voice/engine run typecheck`                    | pass, 0 errors                                                                                                                                    |
| `pnpm --filter @optimiq-voice/engine run test`                         | **1865 pass, 12 skip, 0 fail**, 4198 expect(), 81 files                                                                                           |
| `pnpm --filter @optimiq-voice/api run typecheck` (both tsconfigs)      | pass, 0 errors                                                                                                                                    |
| `pnpm --filter @optimiq-voice/api run test` (mocha)                    | **1453 passing, 0 failing**                                                                                                                       |
| `pnpm --filter @optimiq-voice/web run typecheck`                       | pass, 0 errors                                                                                                                                    |
| `pnpm --filter @optimiq-voice/web run test`                            | **878 pass, 0 fail**, 2802 expect(), 43 files                                                                                                     |
| `pnpm --filter @optimiq-voice/web run codegen:check`                   | `permissions.generated.ts is up to date`                                                                                                          |
| `apps/sipd`: `gofmt -l .`                                              | no output                                                                                                                                         |
| `apps/sipd`: `go vet ./...`                                            | clean                                                                                                                                             |
| `apps/sipd`: `go test -count=1 -race -p 1 ./...`                       | **21 ok, 0 FAIL**                                                                                                                                 |
| `pnpm exec oxlint` over all touched dirs                               | exit 0, no diagnostics                                                                                                                            |
| `pnpm exec oxfmt` over all touched dirs                                | 533 files, clean, no rewrites                                                                                                                     |
| events codegen                                                         | not run — `packages/events` and `packages/events-go` are **byte-identical to the baseline**, nothing touched them                                 |

**One flake, not ours.** `go test -race ./...` at the default parallelism fails
`internal/profile/TestArrivalsSelectTheProfileThroughARealSocket` ("the server never bound
127.0.0.1:54621", plus a race in the retry). It is a **fixed-port** test colliding with a sibling
package's test running concurrently; it passes alone and the full suite is green at `-p 1`. The file
is another agent's new `arrivals_transport_test.go` and none of my areas touch it — worth reporting to
that owner as a port-allocation bug (bind `:0` and read the port back).

Nothing committed, staged or stashed. No service restarted. No database migrated (the migration file
is generated, not applied).
