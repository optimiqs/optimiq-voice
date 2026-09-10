# FIX — engine features (metrics, early media, recording pause/resume, STIR/SHAKEN, emergency deviceId)

Area: `apps/engine/src/{calls,media,nats,health,verbs,session,main.ts}`, `packages/events` (additive),
`packages/telephony`, `packages/cdr-db` + the API's CDR writer/query, `apps/api/src/pbx/emergency-addresses`,
`apps/mediad` (recording pause only). Nothing committed. No service restarted, no NATS reload.

Sub-reports with full detail: `FIX-cdr-attestation-deviceid.md`, `FIX-early-media-engine.md`, `FIX-clir.md`.

---

## 1. Engine `/metrics` — DONE

New `apps/engine/src/health/{metrics.ts,metrics-server.ts,engine-metrics.service.ts}` + specs, mirroring
`apps/api/src/core/metrics`: module-singleton `Registry`, `collectDefaultMetrics` with `prefix: "engine_"`
and `eventLoopMonitoringPrecision: 10`, a private `node:http` listener on `ENGINE_METRICS_ADDR`
(default `127.0.0.1:9201`), one route, 404 otherwise, 500 rather than a partial body, bind failure logged
and **non-fatal**. Started in `main.ts` after `app.listen`, closed before `app.close()` in the drain.

**Zero hot-path instrumentation** — every series is a scrape-time read of a counter `/healthz` already
keeps: `engine_active_channels`, `engine_channels_adopted_total`, `engine_draining`,
`engine_sip_invites_total`, `engine_sip_admissions_total`, `engine_sip_refusals_total{reason}`,
`engine_media_ready`, `engine_signalling_ready`, `engine_nats_connected`, `engine_lease_held`,
`engine_lease_renew_failures_total`, `engine_peers_lost_total`, `engine_sip_instances_lost_total`,
`engine_channel_watch_adopted_total`, `engine_channel_watch_stale_recoveries_total`,
`engine_routing_stale_recoveries_total`, `engine_routing_cached`, `engine_routing_invalidations_total`,
`engine_rpc_calls_total{plane,operation}`, `engine_rpc_failures_total`,
`engine_rpc_latency_{p50,p99,max}_milliseconds`, `engine_event_loop_lag_ms`.

`compose.voice.yaml` sets `ENGINE_METRICS_ADDR: 0.0.0.0:9201` (unpublished). Scrape config, the metric
list and two alerts documented in `docs/native-calling-deployment.md` beside the API/sipd/mediad rows;
the runbook's "engine is the blind spot" paragraph rewritten.

One cross-directory edit: `sip-invite.service.ts` kept `served`/`admitted` but no per-reason counter, so
a bounded `Map<SipInviteRefusalReason, number>` and one increment in `refuse()` were added (+1 spec case).

**Deliberately not done — real `_bucket` histograms.** `RpcLatency`'s raw buckets are unreachable: both
`MediadService.rpcLatency` and `SplitPlaneMediaPort.signallingLatency` return the _summarised_
`RpcLatencyReport`. Exposed as p50/p99/max gauges (`-1` → `+Inf`) instead, with the consequence — per
instance, not `histogram_quantile`-aggregatable — stated in the doc comment and the runbook. The
`_calls_total`/`_failures_total` counters beside them are honest and do aggregate.

## 2. Early media — engine step DONE; NOT working end to end (mediad half missing)

- `sipd-event-mapping.ts` now carries `sdpAnswer` through `dialog.progressed` when `hasEarlyMedia`. It was
  being dropped on the floor — the `dialog.answered` branch immediately below already did it right.
- B-leg: settled with **`accept-answer`** (the existing `settleOutboundAnswer`), not create-offer — the
  carrier's 183 answers the offer mediad already wrote at originate, so there is nothing to re-offer.
- A-leg: new `SplitPlaneMediaPort.earlyMedia(channelId)` allocates a mediad session from the stored offer
  and issues `rpc.sip.v1.ring` with `status: 183` and that answer. A **separate `MediaPort` method, not an
  argument on `ring`** — a 180 is a status line, a 183 must produce real SDP, and `AriMediaAdapter` has to
  refuse one while serving the other (`MediaOperationNotSupportedError`; ARI exposes nothing for 183+SDP).
- A-leg found from the B-leg via `OriginateRequest.originatorChannelId`, already passed by the walker,
  recorded on the existing `LegRecord`. No new map, no new eviction — `forget` already bounds it.
- Idempotency and the RFC 3261 §13.2.1 repeat share one latch: the 183's answer is stored on the A-leg
  record, so a repeated 18x is a no-op and `answer` sends those same bytes rather than allocating twice.
  `sendrecv` is asked for at the 183, not `sendonly`, because mediad's `ApplyDirection` never moves the
  session mode — a narrowed leg could not be widened at the 200.
- **`billsec` untouched**: `markAnswered` / `channel.answered` / the duration ceiling stay under `active`;
  the `early` branch returns before the aggregate is reached. Asserted.

**Still missing for a live call (cross-area, mediad):** `session.remote` is learn-only
(`session.go:163,713-728`). During early media the caller sends no RTP, so `forward` bails at
`session.go:631-635` and the announcement is dropped. mediad must seed `session.remote` from the offer's
`c=`/`m=` at allocate. Until then signalling and negotiation are correct and **the caller still hears
silence.** Also stale: `rtp.ts:1855-1861`'s claim that `direction: "sendonly"` is `not_supported` — it is
honoured (`internal/control/handlers.go:64,88-100,867-878`).

**Cross-area (sipd):** delete `apps/sipd/internal/command/handlers.go:84-89`, the `not_supported` for any
183 carrying a body; keep the `status < 180 || status > 183` check above it. Then fix the now-stale doc on
`sipRingRequestSchema.sdpAnswer` ("Refused not_supported until early media ships").

## 3. Recording pause/resume (PCI) — DONE

mediad had only start/stop — no pause, no mute-on-recording. The recorder already runs on its own 20 ms
tick, which made a true pause cheap: **one file, silence gap, real timeline.** Pause flips a flag; the
recorder keeps ticking, writes a zero frame, and discards one queued frame per direction so nothing
replays on resume. The object, its `objectKey` and every post-gap offset are unchanged — exactly what
stop/start destroys.

- **One subject with a `resume` bit**, `rpc.media.v1.pause-recording`, not a pair — the same argument
  `mute-session` makes for `unmute` over a second subject. Both halves carry a reference and nothing else.
- Intervals ride `recording.finished` as `pauses`, not the reply — only the writer knows where the silence
  is in the file.
- mediad: `internal/rtp/{recording.go,manager.go}`, `internal/control/{control.go,handlers.go,lifecycle.go}`.
  No lock held across I/O; the WAV writer stays the recorder goroutine's alone (offsets from an atomic).
- engine: `MediaPort.pauseRecording(name, paused)`, implemented on `MediadMediaPort`, refused on
  `AriMediaAdapter` via the existing `MediaOperationNotSupportedError` (ARI's pause _shortens_ the file, so
  its intervals would not name the silence they describe). `CallControl.pauseRecording` is idempotent and
  does not flip state on refusal.
- Metadata: `recordings.pauses` jsonb + additive migration `20260909212335_cdr_recording_pauses`
  (header notes `recordings` is **not** partitioned, contrasting the `cdr_auth_pin` precedent).
  `recording-writer.service.ts` writes them, and only ever forward — a redelivery with no intervals must
  not erase filed ones.
- **Session-verb exposure (done in a follow-up pass):** `pauseRecord` / `resumeRecord` in `SESSION_VERBS`,
  as a _pair_ rather than a flag — every two-state operation there is spelled as a pair (`hold`/`unhold`,
  `mute`/`unmute`, `park`/`unpark`), and a flag would have needed a new field on the flat
  `sessionVerbArgumentsSchema`. Also in `packages/telephony` `VERB_NAMES`/`Verb` (the executor switch is
  exhaustive over it), `verb-executor.ts` via the existing `controlled(...)` helper so a refusal stays
  data, and `session-verb-mapping.ts`. `session-verb.service.ts` needed no change — it holds no verb list;
  `sessionVerbNameSchema` is the allowlist. Pinned with a test rather than inventing a change. The
  28-member coverage doc comment updated to 30; its "eight it omits" sentence stays true.

**`config/nats.conf` DID need a change** — the grants are enumerated, not wildcard. Three lines added
(engine publish, mediad publish forward-list, mediad subscribe). **HUP reload required, not done.**

**Not done:** a mid-call feature code for pause — it needs `packages/routing`'s `MidCallFeatureAction`
union, `feature-codes.ts` and `snapshot.ts`, all in another agent's package. `record-toggle` untouched.

## 4. STIR/SHAKEN attestation reaches the CDR — DONE

`apps/sipd` already populates `sipInviteRequestSchema.attestation`; nothing consumed it. Now:
leg variables `OPTIMIQ_SIP_ATTESTATION` / `_VERSTAT` / `_ORIGID` stamped in `invitedChannelSnapshot`
(the KV-mirrored mechanism `OPTIMIQ_AUTH_PIN_ORDINAL` uses, so it survives adoption and failover) →
`attestationOf(variables)` in `cdr-leg.ts` mirroring `authorizationOf`, but deliberately **not**
all-or-nothing (a verstat with no level is the useful half; documented) → `sipAttestation`/`sipVerstat`/
`sipOrigId` on `cdrLegWriteDataSchema` → three nullable text columns, no index, migration
`20260909211645_cdr_sip_attestation` (header copied from the `cdr_auth_pin` precedent: partitioned DDL
recursion, metadata-only ADD COLUMNs, nothing backfilled and nothing could be) → the API writer's
mapped-column list, row interface and an `attestation` block in the `authPinOrdinal` style (unrecognised
level dropped **and recorded as a coercion**) → `LEG_LIST_COLUMNS`, which detail spreads, so list and
detail both carry them.

**Bug found and fixed along the way:** `buildCdrLegWrite` never forwarded `authorizationOf`'s result — the
call site spread it into `CdrLegInput`, which had no such fields, so **every gated outbound call reported
no PIN authorisation at all.** Now on the input and the output, with a regression test.

## 5. `call.emergency.dialed` gains `deviceId` — DONE (blocked on one sipd line)

Additive `deviceId` on `callEmergencyDialedDataSchema` and on `sipInviteRequestSchema`. Engine stamps
`OPTIMIQ_DEVICE_ID` and `walkerChannelFor` exposes it; `notifyEmergency` publishes it. The API consumer
uses the event's `deviceId` for the Ray Baum dispatchable location and falls back to the
`callerNumber → extension → device_line → device` inference when absent **or when the named device no
longer exists**.

In `apps/engine/src/routing` (another agent's) exactly two additive things: an optional `deviceId?` on the
`WalkerChannel` port — unavoidable, the port carries no `variables` — and the single spread line in
`notifyEmergency`.

**Cross-area (sipd, one line)** in `apps/sipd/internal/invite/client.go`, where the admission request is
built and `attestation` is already mapped: `req.DeviceID = cred.DeviceID`. Digest only — a trunk INVITE
resolves no credential and must send none. Until it lands the consumer takes the documented inference
fallback; nothing regresses.

---

## Coordinator's two extra items (E2E-routing2.md)

### P1-4 — park timeout recalled the wrong party and dropped the call — FIXED

`ControlledLeg` gains `readonly side: LegSide`, backed by a **getter** delegating to the existing
`legSideOf(aggregate)` — so it reads `OPTIMIQ_LEG`, which is mirrored into the `channels` KV snapshot.
No field that dies with the process; an instance adopting the leg after failover gets the same answer.

New `numberOf(leg)`: `side === "b" ? destinationNumber : callerIdNumber`. `park` spreads `parkedByNumber`
from it instead of `parker.callerIdNumber`, which on a B-leg is the _originating_ party — which is why the
live run recalled to 1203 (the parked party) instead of 1201 (the parker), routed the call to the number
it was already on, resolved `hangup`, and dropped a customer left on hold.

Absent-field case: the field is **omitted**, never filled with the other side's identity.
`returnParkedCall` already handles that correctly — it restores the claim, re-arms the default timeout and
logs "a parked call timed out with no parker to return it to", so the caller stays parked and collectable.

Polarity checked: `SupervisionTarget.side` and `legSideOf` are **not** inverted — "b on a call it
received" is from the extension's own point of view. The duplicated inline expression at
`supervisionTargets` collapsed to call `legSideOf`, one source.

Tests: B-leg parker (the exact live shape), A-leg parker, and an originated parker with no
`destinationNumber`.

**Second thread ("parking from the caller's side produced no park event") — not a defect.**
`MidCallFeatureRuntime.offer`/`captureFor`/`isCurrent` have no direction guard; the asymmetric gate is one
level up in `onChannelDtmf`: `!inbox.isCollecting && midCall.offer(...)`. The caller's A-leg is the leg a
plan walk owns, so a live `gather` takes the digits first and `*5` is swallowed. Deliberate and already
documented at that line. Timeboxed; not chased further.

### P2-3 — no PAI, no CLIR — engine half DONE, sipd half specified

**`callerIdPresentation`** (`allowed` | `restricted`), additive on `sipOriginateRequestSchema` and
`OriginateRequest`. Chosen over `clir` (names only half the vocabulary) and `privacy` (collides with the
SIP header, which is a _consequence_ of `restricted`). It is **structured, not a `headers` entry** —
that field's own doc rule is that the edge refuses names that would let the engine forge identity, so a
contract where withholding a number meant the engine writing `From`/`Privacy` would make the edge's
authorisation decorative. Engine states intent; edge writes headers.

Precedence in `SplitPlaneMediaPort`: `request.variables.OPTIMIQ_CLIR` → the _originating_ leg's stored
`OPTIMIQ_CLIR` (a caller dialling a prefix code stamps their A-leg; the B-leg the walk dials is a
different channel) → the request's `callerIdPresentation` (the setting) → absent ⇒ `allowed`. An
unrecognised override is ignored, not refused — it must not fail a dial. `AriMediaAdapter` and
`MediadMediaPort` ignore it under `target`'s stated additive-and-ignored contract; both now asserted.
`originate-plan.ts` reads the extension setting; the orchestrator spreads the plan's value onto
`media.originate` (I added that line myself — without it the plan computed a value nothing consumed).

**No feature code added** — `*67`/`*82` needs `packages/routing`'s `FeatureCodeAction` union, another
agent's. The engine half already honours `OPTIMIQ_CLIR`, so the follow-up is a handler that writes it.

**sipd spec (not edited).** PAI on **every** outbound trunk INVITE regardless of presentation —
`P-Asserted-Identity: "D" <sip:N@T>` (RFC 3325 §7) — since carriers authenticate on PAI and treat `From`
as display-only; trunk calls only, never toward an untrusted UA. For `restricted`:
`From: "Anonymous" <sip:anonymous@anonymous.invalid>` (RFC 3323 §4.1.1.3, literally that reserved host),
the real identity still in PAI, `Privacy: id` (§4.2 — `id`, not `user`), `Contact` unchanged, no
`Remote-Party-ID`. `sipDomain` is the PAI host always and the `From` host only when allowed; with no
`sipDomain`, PAI falls back to the trunk proxy host, never to `anonymous.invalid`.

**Cross-area for the extension setting:** `ExtensionIndexEntry.outboundCallerIdPresentation?` in
`packages/routing/src/artifact.ts` (~345); the extension-index projection in `compile.ts` copies it only
when `"restricted"`; pbx-db `extensions.outbound_caller_id_presentation text not null default 'allowed'`

- check constraint (optionally the same on `org_settings` for an org default, resolved extension-then-
  settings like `resolve.ts:884`); API extension create/update/response DTO enum under the same `.own` scope
  as `outboundCallerIdNumber`; a web checkbox.

---

## Verification (exact final counts)

| Check                                                | Result                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/engine run typecheck`  | **pass, 0 errors**                                             |
| `pnpm --filter @optimiq-voice/engine run test`       | **1750 pass, 12 skip, 0 fail** (1762 across 78 files)          |
| `pnpm --filter @optimiq-voice/events run typecheck`  | pass                                                           |
| `pnpm --filter @optimiq-voice/events run test`       | **400 pass, 12 skip, 0 fail** (412 across 13 files)            |
| `pnpm --filter @optimiq-voice/events run codegen` ×2 | **IDEMPOTENT** — `packages/events-go` tree hash byte-identical |
| `pnpm --filter @optimiq-voice/telephony run test`    | **259 pass, 0 fail**                                           |
| `pnpm --filter @optimiq-voice/cdr-db run typecheck`  | pass                                                           |
| `pnpm --filter @optimiq-voice/cdr-db run test`       | **75 pass, 35 skip, 0 fail** (110 across 7 files)              |
| `pnpm --filter @optimiq-voice/api run test`          | **1413 passing, 1 failing** (not mine — see below)             |
| `pnpm --filter @optimiq-voice/api run typecheck`     | 1 error, not mine — see below                                  |
| `apps/mediad`: `gofmt -l .` / `go vet ./...`         | clean / clean                                                  |
| `apps/mediad`: `go test -race -count=1 ./...`        | all ok except 2 port-allocator flakes — see below              |
| `oxlint` / `oxfmt` over every touched dir            | clean                                                          |

**The two API failures are another agent's in-flight work, confirmed against `git status`:**
`apps/api/src/pbx/feature-codes/feature-codes.service.ts(79,59)` (a `search` property on a paging type)
and `test/pbx/orgSettings.test.ts` (asserting the catalogue lacks `defaultCallingCode`). Both files are
modified in the working tree by the feature-codes / org-settings passes and were touched by none of mine.

**mediad `internal/rtp`:** `TestConcurrentAllocateIssuesDistinctPorts` and `TestAllocateSurfacesExhaustion`
fail. Pre-existing and environmental — they exercise the port allocator (39000–39009), which this pass did
not touch, and fail 3/3 in isolation and 2/3 with the new tests excluded; another agent's mediad tests are
holding those ports concurrently. The 4 new pause tests pass.

## needs-restart / reload

- **nats-server — HUP reload required** for the three new `rpc.media.v1.pause-recording` grants. Not done.
- **mediad** — rebuild + restart (recording pause; and the early-media `session.remote` seeding once written).
- **engine** — restart (metrics listener, early media, pause verb, park recall, CLIR, attestation stamping).
- **apps/api** — restart, and `pnpm --filter @optimiq-voice/cdr-db db:migrate` for the two new columns
  (`call_legs` attestation ×3, `recordings.pauses`).
- **sipd** — restart once the two cross-area lines land (`req.DeviceID`, the `HandleRing` refusal deletion).

## Cross-area needed (consolidated)

1. **sipd** — `apps/sipd/internal/invite/client.go`: `req.DeviceID = cred.DeviceID` (digest only).
2. **sipd** — delete `internal/command/handlers.go:84-89`; fix the stale `sipRingRequestSchema.sdpAnswer` doc.
3. **mediad** — seed `session.remote` from the offer's `c=`/`m=` at allocate. **Early media does not work
   without this**; fix the stale `sendonly` `not_supported` doc at `rpc.ts:1855-1861` too.
4. **packages/routing** — `MidCallFeatureAction` for a recording-pause feature code; a `*67`/`*82`
   `FeatureCodeAction` whose handler writes `OPTIMIQ_CLIR`; `ExtensionIndexEntry.outboundCallerIdPresentation`.
5. **pbx-db / apps/api / apps/web** — the `outboundCallerIdPresentation` column, DTO and toggle.
6. **apps/api / softphone** — `pauseRecord`/`resumeRecord` are reachable on the wire; no UI affordance yet.
