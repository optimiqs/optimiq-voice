# FIX — E2E-final3, all ten findings

Areas touched: `apps/engine` (all), `apps/sipd` (`internal/dialog`, `internal/invite` — F4 names the
early-media path). **`apps/api`, `packages/events`, `packages/events-go`, `packages/routing`,
`packages/telephony` and `config/nats.conf` were NOT touched**, so no codegen, no migration and no
broker reload is owed by this work. Nothing committed, staged or stashed. No service restarted.

---

## F2 — `sip_call_id` unwritable on a B-leg, and an answering party's REFER unroutable — FIXED `P0`

Two halves, because the value had no source at all on the split plane.

- **`media/split-plane.port.ts` `originate`** — the reply to `rpc.sip.v1.originate` already carries
  `sipCallId` (sipd fills it: `internal/command/handlers.go:376`), and nothing read it. It is now
  stamped on the leg as `OPTIMIQ_SIP_CALL_ID`. That is the only moment this side is ever told the
  dialog's Call-ID synchronously: there is no PJSIP session to ask, and `getVariable` is a local map.
- **`calls/channel-orchestrator.service.ts`** — `readSipCallId` now takes `(mediaChannelId,
variables)` and asks the port for `OPTIMIQ_SIP_CALL_ID` **before** `CHANNEL(pjsip,call-id)`. Only
  one of the two exists per plane and asking in the other order cost the B-leg its dialog.
  `recordSipDialog` was split so `recordSipDialogFor(aggregate)` can run without a snapshot, and
  `onCallStateChanged` calls it on the leg's first state change **when the port is the split plane
  and the leg has no Call-ID yet**. That is the first moment the engine is called again for a leg
  whose aggregate was filed by `legHooksFor(…).originated` before the INVITE went out. Gated on
  `SplitPlaneMediaPort` so ARI pays no extra HTTP round trip per state change.

Consequences closed: `call_legs.sip_call_id` on B-legs, and `registry.indexSipDialog` → so
`resolveSipDialog` finds the callee's dialog and the engine stops answering `unknown_dialog` to a
REFER from the party who ANSWERED (item 11), and very likely `*5` in that orientation (item 5A).

Tests: `split-plane.port.spec.ts` (stamped from the reply; absent when the reply names none) and
`channel-orchestrator-routing.spec.ts` "records the dialog the originate reply named, on the leg's
first state change" — verified to FAIL with the port change stashed.

## F7 — the main routing walk dropped `callerIdPresentation` — FIXED `P1`

One spread added to `walk({…})` in `startRoutedProgram`, beside the `callerIdNumber`/`callerIdName`
that were already passed. Every layer `FIX-clir-refer-pause` §1 added is now reachable from a
softphone and a desk phone, not only from click-to-call.

Tests: new `caller-id presentation on the ordinary routing walk` block in
`channel-orchestrator-routing.spec.ts` — restricted reaches `media.originate`, allowed carries
nothing. Verified to FAIL on the old file.

## F1 — a synthetic feature-code id made a CDR unwritable and never freed the leg — FIXED `P0`

Both halves, as briefed.

- **`routing/plan-destination.ts`** — the `feature-code` case emits `destinationRef` only when it is
  a UUID. The compiler mints `feature-code:<kind>:<uuid>` for the `*65`/`*64` call-flow and
  time-condition toggles, which have no `feature_code` row; the TYPE still travels, exactly as it
  does for `external`. (`packages/routing/compile.ts` was NOT edited — out of grant, and the engine
  side is sufficient. See "Cross-area".)
- **`channel-orchestrator.service.ts` `writeCdr`** — envelope construction and `validateEvent` are
  now in their own try/catch and a failure there is treated as **permanent**: the row is dropped, the
  error names `destinationType`/`destinationRef`, and `writeCdr` returns `true` so the leg is
  released. `makeCdrLegWriteEvent` is where "Invalid UUID" actually came from (`makeEvent`
  `safeParse`s), so the catch has to wrap it and not only `validateEvent`.

Tests: `plan-destination.spec.ts` (both synthetic forms and a non-UUID dropped; a real UUID kept) and
`channel-orchestrator.spec.ts` "drops a CDR its own contract rejects rather than retrying it
forever" — asserts `cdrs 0`, `pendingCdrRetryCount 0`, `activeChannelCount 0`, `kv 0`. Verified to
FAIL on the old file.

## F4 — the 183+SDP → bodyless 180 — FIXED, and the audit's layer was one below where it looked

**The engine did NOT downgrade the response.** `SplitPlaneMediaPort.earlyMedia` sends
`status 183` with `mediad`'s answer and sipd's `Ring` handler honours it (`handlers.go` accepts
180–183 and refuses a body on anything but 183). The wire was right; the EVENT was wrong.

`internal/dialog/dialog.go` `effectsFor(TriggerLocalEarlyMedia)` produced two effects — a RESPOND
carrying `183` and the body, and a PUBLISH carrying **neither**. `internal/invite/executor.go`
`eventFor` reads the event off the effect it is handed and defaults a status-less publish to 180. So
a correct 183-with-SDP was announced to the engine as `status 180, hasEarlyMedia false, no
sdpAnswer` — the shape of plain ringback, which is exactly what the round observed at `00:48:38.402`
(6 ms after the carrier's 183, and matching mediad's own log: the A-leg session was allocated at
`.3999` and its codec settled at `.401`, i.e. `earlyMedia` ran).

Fixed in four places:

1. **sipd `dialog.go`** — the early-media publish effect carries `Status: 183` and the body; the
   `TriggerLocalRing` publish carries its status too (a 181/182 was reported as a 180).
2. **sipd `executor.go`** — the body is put on the event **only for a UAC leg**, which is what
   `sipDialogProgressedDataSchema.sdpAnswer` says ("Present only on a UAC leg"). The engine feeds a
   `progressed` `sdpAnswer` straight into `mediad.acceptAnswer` for the leg the event names, so
   without this gate the newly-correct UAS event would have settled the CALLER's session against the
   caller's own answer — a leg with no audio for the life of the call.
3. **engine `media/sipd-event-mapping.ts`** — the same gate on the reader's side (`role === "uac"`),
   so an older or foreign edge cannot cause it either.
4. **engine `onCallStateChanged`** — a leg already in `early` is no longer regressed to `ringing` by
   a later 180. The state machine allows the edge (a leg can genuinely fall back to ringback) but on
   this path the 180 is a retransmission, and letting it win reported a leg carrying audio as merely
   alerting on the `channels` mirror the softphone and the wallboard read.

**Honest limit.** The item-4 symptom "no caller audio even after the 200" is not fully explained by
these four. mediad's log for that call shows the A-leg allocated and settled at the 183, both
sessions bridged at the 200, and no second settle on the A-leg — i.e. the platform did what it
should. The remaining suspect is the browser: JsSIP sets the remote description from the 183 and the
200 repeats the same answer (RFC 3261 §13.2.1), and `apps/web` is outside this brief. **The next
live round should re-check item 4 against a NON-WebRTC caller first** — if that one has audio, the
residue is `apps/web`'s and not the engine's.

Tests: sipd `dialog_test.go` ×2 (the 183 publish carries 183 + body; a ring's status travels),
`internal/invite/early_media_event_internal_test.go` (UAC carries the answer, UAS carries only the
flag), engine `sipd-event-mapping.spec.ts` (the UAS answer is dropped; the existing UAC case now
pins `role: "uac"` explicitly), `channel-orchestrator.spec.ts` "does not let a later 180 take a leg
back out of early media".

## F5 — the pre-route release cut the CALLER's leg — FIXED `P1`

**Root cause, and it is neither `recallSharedLine` nor `parkPeer` releasing the wrong leg.** Both
release the correct one. `plan-walker.ts` `bridgeWith` registers a watcher on the PEER's leg, and
`onPeerEnded` then hangs up **its own leg** with `NORMAL_CLEARING`. That closure survives park and
survives a shared-line hold — both of which take the caller OUT of the bridge and then end the leg on
the other side. So the original walk's watcher fired and killed the caller three milliseconds before
the recall's own dial began, which is the log line the round found in front of every failure.

- **`routing/plan-walker.ts`** — `onPeerEnded` returns early when `this.deps.channel.bridgeId !==
bridgeId`, i.e. the leg has already left the bridge this watcher is about. `WalkerChannel` gained a
  readonly `bridgeId` (the orchestrator's real one reads `aggregate.snapshot.bridgeId`; the ten spec
  fakes were updated, three of them wired to the `state.bridgeId` they already tracked).
- **`calls/call-control.ts` `recallSharedLine`** — clears the caller's `setBridge(undefined)` beside
  the peer-pointer cut it already did, before the holder's hangup. `park` already cleared both, which
  is why the comparison is the thing that makes the clearing mean something.

Tests: `plan-walker.spec.ts` — "leaves the leg alone when the peer of a bridge it has already left
ends" (verified to FAIL on the old walker) and its opposite, "still ends the leg when the peer of the
bridge it IS in hangs up". `call-control.spec.ts` — the existing recall case now asserts the caller
left the bridge BEFORE the holder's leg went (the route re-bridges it afterwards, so the order is
the fact worth pinning).

Also reported by the round and **not fixed**: after a successful retrieve the `shared-line-state`
lamp still names the previous appearance. `retrieveSharedLine` re-points via `lines.resume(...)`;
that is a separate defect and was not reproduced here.

## F6 — a queue callback to an internal caller could never be dialled — FIXED `P1`

- **`calls/originate-plan.ts` `planQueueCallback`** — internal first, then outbound, and the result
  now reports which rung matched (`context: "internal" | "outbound"`). The collision the
  outbound-only rule feared is not one: `resolveInternal` matches only what is in the tenant's
  internal table, and a customer's number is an E.164 no extension table contains — so an external
  number takes the outbound rung unchanged.
- **`channel-orchestrator.service.ts` `placeQueueCallbackCall`** — an on-net callback is dialled as
  an AOR at the tenant's realm through `ENGINE_EXTENSION_DIAL_TEMPLATE` (the trunk-only branch
  refused every internal target with `invalid_target` even once the plan resolved), and carries
  `OPTIMIQ_CALL_DIRECTION: "internal"` so an on-net callback is not billed as a carrier minute. A
  tenant with no realm is refused by name.

Tests: `originate-plan.spec.ts` — the old "never takes an internal match" case asserted the wrong
thing and was replaced by two ("dials an internal caller back, and says which rung matched"; "still
dials an external number outbound"). `channel-orchestrator-routing.spec.ts` — "dials an internal
caller back on net, and bills it as an internal call" (endpoint, AOR target, direction, dialed).

`GET /queues/:id/callbacks` (404) is `apps/api`'s and is still open — see Cross-area.

## F8 — the `*67`/`*82` re-entrant dial lost the caller's outbound number — FIXED `P2`

`routeLeg` resolved the route (and therefore already had `resolved.callerIdNumber` /
`callerIdName` / `callerIdPresentation`, which is the extension's own outbound cascade) and passed
**none** of it to the walk. A re-entrant dial supplies no caller id on the request, so the trunk
attempt had none and the INVITE asserted the edge's identity — under `Privacy: id` the harmful
direction, since the network is told to withhold an identity that was never asserted. The request's
value still wins where there is one (a blind transfer passes the transferee's).

Test: `channel-orchestrator-routing.spec.ts` "carries the resolved identity onto a re-entrant dial
that supplies none" — drives `routeLeg` directly and asserts `+15005550999` and `restricted` on the
originate. Verified to FAIL on the old file.

## F9 — the recording flags never reached the channel snapshot — FIXED (partially diagnosed) `P2`

`markRecording` → add/remove flag → `putChannel` is correct and was already unit-proven
(`channel-orchestrator.spec.ts` "mirrors the recorder's state onto the channels bucket"), and the
live log shows both verbs succeeding on leg `01a088d6-ecff-…`. What it did NOT do is stamp the OTHER
leg. A conversation recording covers both parties, and the surface that draws the indicator is the
softphone of whoever is ON the call — which reads its own `channels` row. That row said
`flags: ["answered"]`, which is exactly the round's observation.

`markRecording` now fans out to the recorded leg **and** its `OPTIMIQ_BRIDGE_PEER_LEG_ID`, and warns
(rather than silently returning) when this instance no longer holds the named leg.

Test: `channel-orchestrator.spec.ts` "stamps the recording flags on the bridged peer too, which is
the row the softphone reads" — start / pause / resume, asserted on the PEER's KV row.

**Stated honestly:** I could not prove from the logs which row the round read, so this closes the
mechanism that best fits the evidence rather than a reproduced failure. If the next round still
shows `["answered"]` on both rows, the new warn names the leg.

## F3 — hot desking cannot be exercised — CONFIRMED, no code defect `P2`

Verified rather than patched. `plan-walker.ts` requires `channel.deviceId`, which reads
`OPTIMIQ_DEVICE_ID`; `channel-orchestrator.service.ts:5341` stamps it from the admission request and
`ARRIVAL_VARIABLES` reads it back (`FIX-engine-final` §1, already in the running build). Browser
softphones and the load roster register with credentials that carry no `device` row, so the variable
is legitimately absent and `*31` correctly refuses `FACILITY_NOT_SUBSCRIBED`. **Needs a provisioned
device-backed endpoint before it can be judged** — a provisioning task, not an engine change.

## F10 — ten enabled trunks are invalid at rest — CONFIRMED, data cleanup `P3`

`FIX-final-defects` §2 working as designed: sipd refuses a registering trunk with no auth user and
says so once per row at boot, and the API already refuses to create such a row. The ten
`admmtub*`/`admmtuc*` fixture rows (`auth_user=''`, `sip_secret_ref=''`, `enabled`) want disabling or
deleting. **No code change made** — suppressing the ERROR would remove the one signal that a tenant's
trunk will never register. Left as an operator action; I did not touch the live database.

---

## Additional fixes noticed in files touched

- sipd `TriggerLocalRing`'s publish effect carried no status, so a `181 Call Is Being Forwarded` or a
  `182 Queued` sent through `rpc.sip.v1.ring` was announced to the engine as a plain 180. Fixed with
  F4's half and pinned by its own test.
- `readSipCallId` used to give up on the FIRST failed read; it now tries the other name before
  answering `undefined`.
- The stale `planQueueCallback` doc block ("`internal` is never consulted") and the
  `originate-plan.spec.ts` describe header were corrected to what the code now does.

## Cross-area needed (not made)

1. **`packages/routing/src/compile.ts:3391` `toggleCode()`** — stop minting
   `featureCodeId = "feature-code:<kind>:<uuid>"`, or give the toggle nodes a typed
   `destination` of their own. The engine now refuses to put it on a CDR, so the leg is released
   either way; this would remove the synthetic id at its source.
2. **`packages/events/src/schemas/cdr-events.ts`** — optional: `destinationRef` could be widened to
   `z.union([z.uuid(), z.string().max(128)])` if a non-row destination is ever worth recording. Not
   needed for the fix.
3. **`apps/api`** — `GET /queues/:id/callbacks` is still 404, so a pending callback cannot be
   inspected (F6's second half).
4. **`apps/web`** — the residue of F4's "no audio after the 200" for a WebRTC caller, if the next
   live round reproduces it against a non-WebRTC caller. `jssip-adapter.ts` re-applying the 200's
   repeated answer in `stable` state is the specific suspect.
5. **Data** — F10's ten fixture trunk rows.

## Verification (exact final output)

| Command                                         | Result                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/engine` `tsc --noEmit`                    | clean, 0 errors                                                             |
| `apps/engine` `bun test`                        | **1897 pass, 26 skip, 0 fail**, 4268 expect(), 83 files (was 1886/26/0)     |
| `pnpm exec oxlint apps/engine/src`              | exit 0, no diagnostics                                                      |
| `pnpm exec oxfmt apps/engine/src`               | 191 files, no rewrites left; tsc + full suite re-run after it, still 1897/0 |
| `apps/sipd` `gofmt -l .`                        | no output                                                                   |
| `apps/sipd` `go vet ./...`                      | clean                                                                       |
| `apps/sipd` `go test -count=1 -race -p 1 ./...` | **all packages ok, 0 FAIL**                                                 |
| `apps/api`                                      | **not touched** — no typecheck or test owed                                 |
| `packages/events` / `events-go`                 | **not touched** — no codegen owed, no parity change                         |

Regression tests verified to fail on the pre-fix code (by stashing the source file and re-running):
F1's CDR drop, F2's dialog indexing, F5's peer-hangup guard, F7's presentation, F8's re-entrant
identity. F4's sipd halves and F6 replace assertions that pinned the wrong behaviour.

## needs-restart / reload list

- **`nats-server`** — **no reload owed by this work.** `config/nats.conf` was not touched and no new
  subject is used. (The outstanding HUPs from `FIX-recording-control` §1 and `FIX-engine-features`
  §3 are unaffected either way — the round's item 12 proves they already landed.)
- **`apps/engine` — RESTART REQUIRED.** F1, F2, F4 (two of four halves), F5, F6, F7, F8, F9 are all
  engine code.
- **`apps/sipd` — REBUILD + RESTART REQUIRED.** F4's `internal/dialog` and `internal/invite` halves.
  Restart order: **sipd first, then engine** — the engine's new `role`-gated mapping is correct
  against both the old and the new sipd, but the new sipd's honest `183` event is only useful to the
  new engine.
- **`apps/mediad`** — not touched, no restart.
- **`apps/api`** — not touched, no restart.
- **`apps/web`** — not touched.
- **No migration**, no `packages/*` rebuild, no database change.

### What the targeted live re-check should look at

1. Item 11 / item 5A — a REFER and a `*5` from the party who ANSWERED (F2).
2. Item 8 — an extension set `restricted` dialling a trunk: `Privacy: id` on the wire (F7).
3. Item 9 — `*67<dest>`: the PAI must now assert the caller's own `+15005550999` (F8).
4. Item 4 — the 183 event should now read `status 183, hasEarlyMedia true` on a UAC leg and
   `status 183, hasEarlyMedia true, no sdpAnswer` on the UAS leg; **run it once with a non-WebRTC
   caller** to settle where the audio loss lives.
5. Item 6 / park — the recall should now reach the appearance instead of aborting (F5).
6. Item 7 — a callback to an internal extension should dial rather than refuse `invalid_target` (F6).
7. Item 13 — the softphone control, reading its own leg's row (F9).
8. `*65`/`*64` — a toggle call must now write its CDR and free its leg (F1).
