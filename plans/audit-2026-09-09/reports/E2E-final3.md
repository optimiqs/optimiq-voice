# E2E-final3 — closing verification round on the restarted stack

2026-09-10, 00:30–01:10 UTC. Sole owner of the stack for the round. Nothing committed, staged or
stashed; **no application code changed** (see §4 — every defect below is a finding, not a fix).
Stack left **running and green**.

---

## 1. Steps 1–3: reload, migrate, restart

| Step                                 | Evidence                                                                                                                                                                                                                                                                                                                                            | Verdict  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `config/nats.conf` valid             | `nats-server -t -c config/nats.conf` (distinct placeholder users) → `configuration file config/nats.conf is valid (sha256:4f40778…)`                                                                                                                                                                                                                | **PASS** |
| Broker reloaded                      | `kill -HUP 55950` → `Trapped "hangup" signal`, `Reloaded: authorization users`, `Reloaded: accounts`, `Reloaded server configuration`; `/healthz` 200                                                                                                                                                                                               | **PASS** |
| Zero new violations                  | **1008 before, 1008 after the HUP.** (End of round: 1009 — the one extra is **mine**, `19:37:21 … "_INBOX.HTEB…" SID 1`, my own KV probe run with the api credential and the wrong inbox prefix. Not a platform defect.)                                                                                                                            | **PASS** |
| Migration applied, DB not reset      | `node .scripts/migrate-platform.mjs --expected-stage development` (the exact `up.sh:34` command) → `All platform migration journals are current`. `optimiq_pbx.extension.outbound_caller_id_presentation text not null default 'allowed'` + `extension_outbound_caller_id_presentation_check`; **1748 / 1748 existing rows defaulted to `allowed`** | **PASS** |
| Restart sipd → mediad → engine → api | every `/healthz` **200**, every `/metrics` **200** on the private listener (`:9200 :9201 :9290 :9291`)                                                                                                                                                                                                                                              | **PASS** |
| Four authenticated broker users      | `sipd: 1`, `mediad: 1`, `engine: 2`, `api: 23`                                                                                                                                                                                                                                                                                                      | **PASS** |

`packages/{events,telephony,routing,pbx-db,auth}` `dist` were rebuilt first — the **api** imports them
as built output. `web` was left alone (`next dev`).

**One thing the restart exposed** — see finding **F1**: the engine came up with `activeChannels: 2`
and 483 lines of `failed to publish the CDR for a finished leg … destinationRef: Invalid UUID`,
first logged at 22:49 UTC, i.e. **before** my restart. I deleted the two stale `channels` KV entries
and restarted the engine (`activeChannels: 0`) so the round was measurable, and changed no code.

---

## 2. Step 4: the re-drive, with evidence

| #   | Item                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Verdict                                                                  |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **STIR/SHAKEN attestation columns from a trunk INVITE**                                   | Two unauthenticated carrier INVITEs on the external profile (`:5162`) for DID `+15005550201`, both answered by browser 1204 with two-way audio (80 pkt, energy 8 063). `call_legs`: `sip_attestation=A, sip_verstat=tn-validation-passed, sip_orig_id=final2-origid-0001, from_number=+15125550123`; and with `Privacy: id` + `attest=B`: `sip_attestation=B, sip_orig_id=final2-origid-0002, from_number=anonymous`. Was FAIL (columns 0-populated) in `E2E-final2`.                                                                                                                                                                                                                                                                                                                                       | **PASS**                                                                 |
| 2   | **`sip_call_id` on new CDR rows**                                                         | Same two calls: **A-legs carry it** (`final2-attest-cf17080ae6e2@carrier.rt2.test`, `final2-clirin-c6b6f75a3f2b@…`). **B-legs are empty** — `4 rows, 2 with a call id`. Layer in **F2**. Was 0 of 15 220.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PARTIAL** (A-leg only)                                                 |
| 3   | **Hot-desk login/logout, routing following the agent**                                    | `*31`/`*32` now seed and compile (created in the org, both in the artifact with the right actions). Dialling `*311202` from browser 1201: engine logs `feature code *31 (hotdesk-login) was dialled from a leg with no device identity; there is no handset to rebind`, walk `hangup / FACILITY_NOT_SUBSCRIBED`. Blockers (a) and (b) of `E2E-final2` row 13 are closed; **(c) remains** — see **F3**.                                                                                                                                                                                                                                                                                                                                                                                                      | **FAIL** (no device-backed endpoint)                                     |
| 4   | **Early media: 183+SDP, caller energy > 0 pre-answer**                                    | Fake carrier `100 → 183+SDP → 8 s tone → 200`. On the bus: sipd emits `dialog.progressed` **uac status 183 hasEarlyMedia true sdpAnswer present** at `00:48:38.396`. **6 ms later the engine emits `dialog.progressed` uas status 180, `hasEarlyMedia: false`, no SDP** — the 183 body is dropped, and the new `"early media arrived on a leg with no known originator"` warn never fires. Caller inbound RTP **0 packets for the whole 16 s — including the 8 s AFTER the 200**. Control with `MODE=answer` (no 183) on the same path: **first audio at 1 265 ms, 149 packets**. So a 183-with-SDP costs the leg its audio permanently, not just pre-answer. Layer in **F4**.                                                                                                                              | **FAIL** (worse than `E2E-final2` row 4, which still bridged at the 200) |
| 5   | **Park `*5`, both orientations**                                                          | **Orientation B — presser 1203 (the party that PLACED the call): PASS.** Post-park packet delta presser `-67` (their own leg released — the `FIX-engine-final` §4 half), peer 1201 `+334` (in the orbit on MoH), and the **recall rang 1203, the presser, after 25 s** (timeout 20 s). Every half of row 16 that was broken is fixed in this orientation. **Orientation A — presser 1201 (the party that ANSWERED): FAIL.** Both deltas `-67` (both legs dropped), **no park recorded and not one engine log line for the `*5`**, no recall in 46 s.                                                                                                                                                                                                                                                        | **PARTIAL** — B PASS, A FAIL                                             |
| 6   | **Shared line 4500: hold → retrieve from another appearance → recall**                    | Seize **PASS** (`shared-line-state` rev 1 `state:"seized"`, appearance 0 / ext 1202). Hold **PASS** (`state:"held"`, `heldAtMs`). **Retrieve PASS — this is new**: 1203 dialled 4500 inside the recall window and the engine logged `shared line "…" was retrieved from hold by this appearance`; 1203 went active with **192 inbound RTP packets**. (`E2E-final2` recorded this as refused _"the leg has not answered"_; `FIX-engine-final` §5 fixed it. The final2 harness only ever saw the failure because its tab-reload cost ~20 s and the 15 s recall consumed the call first — my `sl-retrieve.mjs` closes the window to 6 s.) **Lamp after retrieve is WRONG** — still `state:"seized"` naming 1202's extension and 1202's `legId`. **Recall FAIL** — see **F5**. Release **PASS** (bucket empty). | **PARTIAL** — 3 of 5                                                     |
| 7   | **Queue callback end to end, agent logged in via `POST /queue-agents/:id/session/login`** | The session endpoint is the right one and works: `201`, `status:"available"`, `since` stamped. **Opt-in PASS** (`the caller accepted a callback by key after 9s; their place is held for 1201`). **The runner now fires** — `E2E-final2` saw _no_ `queue-callback` RPC on the bus at all; it now runs every 30 s, so `FIX-engine-final` §6's root cause was correct. **The dial-back is refused**: `refused a queue callback {queueId:…, reason:"invalid_target"}` ×3. Layer in **F6**. `GET /queues/:id/callbacks` still **404**. `related_call_id` therefore still unset.                                                                                                                                                                                                                                 | **PARTIAL** (opt-in + runner)                                            |
| 8   | **CLIR — restricted via the extension setting**                                           | Every layer below the engine is now right: `PATCH /extensions/:id {outboundCallerIdPresentation:"restricted"}` → 200, and the compiled artifact in `routing-cache` carries `"outboundCallerIdPresentation":"restricted"`. **The wire is unchanged**: the trunk INVITE still carries `From: "RT2 Alice" <sip:+15005550999@carrier.rt2.test>`, a plain PAI and **no `Privacy` header**. Layer in **F7** — one missing line.                                                                                                                                                                                                                                                                                                                                                                                   | **FAIL**                                                                 |
| 9   | **CLIR — restricted via `*67<dest>`**                                                     | Works as privacy: `From: "Anonymous" <sip:anonymous@anonymous.invalid>`, **`Privacy: id`**, PAI present. **But the PAI asserts `<sip:optimiq-sipd@carrier.rt2.test>`, not the caller's real `+15005550999`** — the whole point of PAI under `Privacy: id`. Layer in **F8**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **PARTIAL**                                                              |
| 10  | **CLIR — `*82` override**                                                                 | `feature code *82 is dialling 15551230001 with caller id allowed`; the INVITE carries **no `Privacy` header** and a non-anonymous From. The presentation flag is correct. (The number is wrong for the same reason as #9 — **F8**.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **PASS** (presentation)                                                  |
| 11  | **Blind transfer initiated by the party who ANSWERED**                                    | **sipd's half is FIXED.** No 401 and no _"the transfer to 1202 was refused"_ banner; sipd accepts the REFER and resolves the right identity — `aor: "sip:1201@rt2mtuiyokf.local.test"` (it was the anonymous instance URI `mdokeqt0@…invalid`). **The engine then refuses it**: `WARN the engine refused the transfer … reason:"unknown_dialog" detail:"no live call on this instance matches that Call-ID"`. 1202 never rang, transferor stayed on the call. Same root cause as #2 — see **F2**.                                                                                                                                                                                                                                                                                                           | **FAIL** (moved from sipd into the engine)                               |
| 12  | **Recording pause/resume from the API for a softphone-driven call**                       | `POST /api/v1/calls/:id/recording/pause` → **200** `{paused:true, legId, instanceId:"e2e-engine-1"}`; `…/resume` → **200** `{paused:false}`. **One** recording object, `kind:"call"`, `durationMs 14080`, `sizeBytes 225324`. The WAV analysed at 200 ms granularity: RMS ≈ 23 900 for buckets 0–19, **exactly 0 for buckets 20–44**, ≈ 23 898 for 45–70 — **a 5.0 s silence gap at 4.0–9.0 s**. `recordings.pauses = [{"startMs": 3940, "endMs": 9060}]`. This also proves the whole new transport: the api published on `rpc.engine.v1.call-control.*` and the engine answered, so the HUP'd grants, the org/leg/ownership checks and the responder are all live.                                                                                                                                         | **PASS**                                                                 |
| 13  | **The softphone recording control appears while recording**                               | **The `recording` / `recording-paused` flags never reach the live channel**: `flags: ["answered"]` throughout, before and after a pause the engine confirmed with a 200. The browser therefore shows no indicator and no pause button. Layer in **F9**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **FAIL**                                                                 |
| 14  | **Smoke call**                                                                            | `MAIL_DIR=<scratchpad>/e2e/mail node .scripts/local-stack/smoke-call.mjs` — **9 / 9 PASS** on a populated stack: fresh org + realm `smokemtutrkr0.local.test`, mail verification, both softphones registered over WSS, caller 23 pkt / callee 23 pkt, hold+resume renegotiated and restored both ways, hangup propagated, 2 CDR legs. (`MAIL_DIR` is needed — the script defaults to `<repo>/mail`; noted in STACK.md.)                                                                                                                                                                                                                                                                                                                                                                                     | **PASS**                                                                 |
| 15  | **Load sanity, 50 concurrent**                                                            | see the table below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **PASS**                                                                 |

### Load table — `TestE2ECallStorm`, 50 pairs, 20 s

| Metric            | Result                                     |
| ----------------- | ------------------------------------------ |
| Registration      | 100/100 phones in **233 ms**               |
| Calls             | **50, 0 failed**, wall 20.24 s             |
| Setup-to-ring     | **p50 138.2 ms · p99 147.6 ms**            |
| Ring-to-audio     | p50 34.2 ms · p99 40.4 ms                  |
| Teardown          | p50 2.03 ms · p99 2.77 ms                  |
| RTP               | **99 900 packets, 0 lost (0.0000 %)**      |
| Goroutines sipd   | 56 baseline → 500 at peak → **50 at rest** |
| Goroutines mediad | 45 → 45 → **45**                           |
| New WARN/ERROR    | **0** in sipd, mediad, engine, api, nats   |
| Engine after      | `status: ok`, `activeChannels: 0`          |

### Counts

**5 PASS · 5 PARTIAL · 5 FAIL** across the 15 re-driven items (steps 1–3 add 6 further PASS).
Newly closed since `E2E-final2`: STIR/SHAKEN columns, shared-line retrieve, park in the caller
orientation, the queue-callback runner firing, the sipd half of the answering-party REFER, and
recording pause/resume end to end.

---

## 3. Findings — every one with the exact layer. None fixed.

**F1 — a synthetic feature-code id makes a CDR unwritable, and the leg is never freed.** `P0`.
`packages/routing/src/compile.ts:3391` `toggleCode()` mints `featureCodeId = "feature-code:<kind>:<uuid>"`
for the `*65`/`*64`-style call-flow and time-condition toggles (there is no `feature_code` row for
them). That id becomes `PlanDestination.destinationRef` (`plan-destination.ts:106`) → `CdrLegInput`
→ `packages/events/src/schemas/cdr-events.ts:54` `destinationRef: z.uuid()`, which rejects it. The
engine then **retries the CDR forever** and never releases the leg: two such legs held
`activeChannels: 2` across a process restart and produced 483 error lines. Observed values:
`feature-code:call-flow:01a087c7-3aba-…` and `feature-code:time-condition:01a087c7-3a5d-…`.
Either omit `destinationRef` for a synthetic node or give the CDR a non-UUID column.

**F2 — `sip_call_id` is unwritable on a B-leg, and the same gap makes an answering party's REFER
unroutable.** `P0`. `channel-orchestrator.service.ts:4548` `readSipCallId` falls back to
`media.getVariable(channel.id, "CHANNEL(pjsip,call-id)")` — an **Asterisk/ARI channel function**.
On the split plane `SplitPlaneMediaPort.getVariable` (`split-plane.port.ts:832`) is a plain local
`Map`, and nothing ever writes that key, so it is always `undefined` for a B-leg. Two symptoms, one
cause: (a) `call_legs.sip_call_id` is populated on A-legs only; (b) `registry.indexSipDialog` is
never called for the B-leg, so `resolveSipDialog` misses and the engine answers `unknown_dialog` to
the REFER a **callee** sends — which is exactly item 11 and, very likely, the `*5` half of item 5.
The A-leg works because sipd stamps the value inline on `rpc.sip.v1.invite`. The fix belongs on the
originate path: stamp `OPTIMIQ_SIP_CALL_ID` on the B-leg from sipd's own dialog Call-ID (sipd already
holds it — the `dialog.progressed` uac events carry `identity.sipCallId`).

**F3 — hot desking cannot be exercised because no endpoint on this stack has a device identity.**
`P2`. `plan-walker.ts:2348` requires `this.deps.channel.deviceId`. The arrival-variable fix of
`FIX-engine-final` §1 is in the running build, but browser softphones and the load roster register
with no `device` row, so the variable is legitimately absent and `*31` refuses
`FACILITY_NOT_SUBSCRIBED`. This needs a provisioned device-backed endpoint before it can be judged.

**F4 — the engine downgrades a 183-with-SDP to a 180 without one, and the leg never recovers.**
`P0`. sipd's half is correct (`dialog.progressed` uac `status 183 hasEarlyMedia true sdpAnswer
present`). 6 ms later the engine emits `dialog.progressed` uas `status 180 hasEarlyMedia false`, no
SDP. Layer: `channel-orchestrator.service.ts` `nextCallState === "early"` → `relayEarlyMedia` →
`SplitPlaneMediaPort.earlyMedia`/`ring`. The `originatorFromLeg` second source added by
`FIX-engine-final` §3 evidently resolves (its new warn never fires), so the loss is **below** it, in
the composition that turns an early answer into a provisional. Worse than the previously recorded
symptom: the caller gets **no audio even after the 200**, where a control call on the same path has
audio in 1.3 s.

**F5 — the pre-route release cuts the CALLER's leg, so park and shared-line recalls are abandoned.**
`P1`. Every recall failure in this round is preceded, 3 ms earlier, by the same line:
`the caller's leg ended (NORMAL_CLEARING/16) while the dial was running; the dial was abandoned`,
then `a shared line's hold recall did not reach the appearance that held it {status:"aborted"}`
(00:52:54, 00:54:31) or `a timed-out parked call could not be returned to its parker
{status:"aborted"}` (00:51:14). `FIX-engine-final` §5 added a `NORMAL_CLEARING` release of the
holder's leg before `routeTransferee` in `recallSharedLine`; the leg it actually ends is the
transferee — the caller being recalled. Same seam as `parkPeer`'s release. `apps/engine/src/calls/call-control.ts`.
Related and separate: after a successful retrieve the `shared-line-state` lamp still names the
**previous** appearance's extension and `legId`.

**F6 — a queue callback promised to an internal caller can never be dialled.** `P1`.
`apps/engine/src/calls/originate-plan.ts:188` resolves the callback destination **outbound-only**,
by design ("_not the internal-then-outbound ladder … the number being dialled is a number that rang
IN_"). Every caller on this deployment is an extension, so `resolveOutbound` matches nothing and the
runner refuses `invalid_target` every 30 s — after the caller was told their place is held.
`FIX-engine-final` §6 supplied the `from`; the `to` is the blocker. Either the callback plan needs
the internal ladder for an internal caller, or the offer must not be made to one.
Still open alongside it: **`GET /queues/:id/callbacks` is 404**.

**F7 — the main routing walk drops `callerIdPresentation`; CLIR by setting is one line from working.**
`P1`. `packages/routing/src/resolve.ts:899` sets `ResolvedRoute.callerIdPresentation` from the
caller's extension, `plan-walker.ts` consumes `WalkInput.callerIdPresentation` and `trunkDialNode`
puts it on the attempt — but `channel-orchestrator.service.ts:1492`, the `walk({…})` every
softphone and desk phone goes through, **does not pass it**. It sits directly beside the
`route.callerIdNumber` / `route.callerIdName` spreads that ARE passed (lines 1503–1504). Only the
click-to-call path (`originate-plan.ts` → line 4751) carries it, which is why
`FIX-clir-refer-pause` §1's five new layers are all live and invisible.

**F8 — the `*67`/`*82` re-entrant dial loses the caller's outbound number.** `P2`.
`plan-walker.ts` `callerIdPresentationCode` stamps `OPTIMIQ_CLIR` and re-enters routing through
`dialThroughControl` → `control.dial`, which runs a fresh walk with a fresh `WalkInput`. The
presentation survives (it is on the leg) but `callerIdNumber` does not: the trunk INVITE asserts
`<sip:optimiq-sipd@carrier.rt2.test>` in both From and PAI instead of `+15005550999`. Under
`Privacy: id` that is the harmful direction — the network is told to withhold an identity that was
never asserted.

**F9 — the recording flags never reach the channel snapshot.** `P2`.
`FIX-recording-control` §3 added `recording` / `recording-paused` to `packages/telephony`'s
`CHANNEL_FLAGS` and a `CallControlHost.markRecording(leg, …)` called at all four edges. With a
recorder demonstrably running (mediad `recording started`, a 14 s WAV, a confirmed pause) the live
`channels` entry read straight from KV shows `flags: ["answered"]` and nothing else, before and
after the pause. The engine's own `markRecording` → add/remove flag → `putChannel` is the layer.
Consequence: the softphone control is never drawn, so item 13 cannot pass however well item 12 works.

**F10 — ten enabled trunks are invalid at rest and sipd now says so on every boot.** `P3`, and
this is `FIX-final-defects` §2 working as designed. sipd logs 10 × `ERROR ignoring an invalid trunk
record; the previous configuration stands … a registering trunk needs an auth user` at startup.
The rows are the `admmtub*/admmtuc*` fixture trunks (`auth_user=''`, `sip_secret_ref=''`, all
`enabled`). The API now refuses to create them; the existing rows want cleaning up or disabling.

---

## 4. What I changed on the stack

- **No application code.** Every defect above is reported, not patched.
- Reloaded the broker, applied the pbx-db migration, restarted sipd/mediad/engine/api.
- Deleted **2 stale `channels` KV entries** (F1's residue, another agent's `*65`/`*64` calls) and
  restarted the engine so `activeChannels` returned to 0.
- **Data added to the routing2 org** (`01a087c3-8c47-7605-9aee-fad39690fb96`), all deletable:
  feature codes `*67` `*82` `*31` `*32`. Extension 1201's `outboundCallerIdPresentation` was toggled
  and left at **`allowed`**; 1202's `recordPolicy` was toggled and left at **`none`**.
- The smoke run left org `01a088d8-671c-75ec-8e9a-4933b2351913` / realm `smokemtutrkr0.local.test`
  and its two users, as the script intends (its extensions were cleaned up).
- New probes under `<scratchpad>/e2e/final3/`: `clir-setup.mjs`, `sl-retrieve.mjs`,
  `qcb-session.mjs`, `blind-answerer.mjs`, `recording.mjs`, `vars.mjs`, plus captures.
- **One trivial breakage of my own, fixed**: my first KV probe used the api credential with the
  default inbox prefix and earned the single new broker violation; re-run with `_INBOX.api`.

## 5. Stack state at hand-off

All eight services green — `postgres`, `nats`, `smtp`, `mediad` (9291), `sipd` (9290),
`engine` (9300), `api` (3200), `web` (3300). `/metrics` 200 on `:9200 :9201 :9290 :9291`.
Engine `status: ok`, `activeChannels: 0`. Broker: `sipd 1`, `mediad 1`, `engine 3`, `api 23`.
