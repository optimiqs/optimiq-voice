# E2E — the 13 NOT RUN rows, driven

Run 2026-09-09 23:0x → 23:45 UTC against the standing stack, by the final2 agent, sole owner of the
stack. Nothing committed, staged or stashed by me. Two new **test-only** source files (§6). The
stack is left **running and green**; **zero new broker permission violations** (`logs/nats.log`
untouched since 17:34, the count still 1 008, all pre-HUP).

Harnesses built for this round live in `<scratchpad>/e2e/final2/`; artifacts in
`<scratchpad>/e2e/artifacts/final2/` and `<scratchpad>/e2e/artifacts/sdes/`.

---

## 1. The table

| #   | Feature                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict                                                                                |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | **SDES-SRTP media over TLS 5161**                                               | New `apps/sipd/e2e_sdes_test.go` + `internal/testutil/sipua/srtp.go` (AES_CM_128_HMAC_SHA1_80 from stdlib, key derivation pinned against the RFC 3711 §B.3 vector). Offer `RTP/SAVP` + `a=crypto:1` over TLS; **answer** `m=audio 32392 RTP/SAVP 0 101` / `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:+WaL1Mp9…` (tag `1` echoed per RFC 4568 §5.1.2, fresh 30-byte key). Inbound datagrams **182 bytes = 12+160+10-byte SRTP auth tag** (plain G.711 is 172); 99/99 authenticated and decrypted under the answer's key, `Undecodable: 0`; **80 zero-crossings/frame on the wire vs 18 after decryption** (660 Hz µ-law ≈ 26, uniform random ≈ 80) — the wire bytes are not the tone, the decrypted bytes are. Outbound: 100 SRTP packets arrive at a plain-RTP B-leg as 99 PCMU, energy 5088 — mediad really decrypted. Plaintext downgrade mid-call: 50 plain G.711 packets to the same negotiated port/5-tuple → far end **99 → 99** (zero delivered), `mediad_rtp_packets_dropped_total{reason="malformed"}` **0 → 50** exactly. Reproduced across two runs. | **PASS** (all three sub-claims)                                                        |
| 2   | **CLIR / PAI on a trunk INVITE — non-restricted**                               | Fake carrier on 127.0.0.1:5199; 1201 (outboundCallerIdNumber `+15005550999`) dials `15551230001` → route "RT2 National". Carrier saw: `From: "RT2 Alice" <sip:+15005550999@carrier.rt2.test>`, **`P-Asserted-Identity: "RT2 Alice" <sip:+15005550999@carrier.rt2.test>`**, **no `Privacy` header**. Two-way audio (149 pkt / energy 0.44 at the browser). PAI on every trunk INVITE, as `FIX-clir.md` specifies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **PASS**                                                                               |
| 3   | **CLIR / PAI — restricted (`Privacy: id`, anonymous From)**                     | Unreachable end to end. `apps/sipd/internal/invite/originate.go:336-361` implements it correctly (anonymous From + `Privacy: id` + PAI with the real number) and `channel-orchestrator.service.ts:4474` passes `plan.callerIdPresentation` — but **nothing can ever set it**: `outboundCallerIdPresentation` exists nowhere in `packages/routing` (compile or `ExtensionIndexEntry`), the live routing2 artifact contains no such key (grep over all 31 451 bytes: absent), there is no DB column, no API field, and no `*67`/`*82` feature code (`DEFAULT_FEATURE_CODES` has neither). The `OPTIMIQ_CLIR` variable path has no writer. `plan-walker.ts` — the path a softphone dialling out actually takes — has **no `callerIdPresentation` at all**; only the click-to-call `originate-plan` reads it. Every cross-area item 1-4 of `FIX-clir.md` is still open.                                                                                                                                                                                             | **FAIL** (feature not reachable)                                                       |
| 4   | **Early media: 183+SDP relayed, caller energy > 0 before answer**               | Carrier answers `100 → 183 + SDP` then streams 8 s of 880 Hz, then `200`. sipd's half is right: on the bus, `dialog.progressed status=183 hasEarlyMedia=true sdpAnswer=<present>`. The caller (browser 1201) received **0 inbound packets for the whole 15 s** — `firstAudioAtMs: null` — in two runs; the engine sent no 183 and logged **nothing**, not even `relayEarlyMedia`'s own warn. The routing walk finished `bridged` only at the 200 (t+9 s). Layer: `channel-orchestrator.service.ts:2891-2898` (`nextCallState === "early"` branch) → `relayEarlyMedia` → `SplitPlaneMediaPort.originatorOf`, which returns silently when the originator is unknown. Control (`180` + `200`, no SDP on the provisional) bridges and passes audio, so the 183 is the differentiator.                                                                                                                                                                                                                                                                               | **FAIL** (stops in the engine)                                                         |
| 5   | **Blind transfer across three phones, audio follows**                           | 1201 calls 1203, answers, `Transfer → 1202 → Transfer now`: 1202 rang, **transferor dropped**, 1203 delta +205 pkt / 1202 +117 pkt of fresh audio. CDR: one `call_id` `c507a503` with A-leg 1201→1203 and **two** B-legs (1203 and 1202), both `answered`, both carrying `originating_leg_id` and `bridge_leg_id` — the linkage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **PASS**                                                                               |
| 5b  | **Blind transfer when the transferor ANSWERED the call**                        | Fails, every time. The softphone shows _"The transfer to 1202 was refused."_ and sipd logs nothing. On the wire (jssip debug + WS frame capture): `REFER … From: "RT2 Alice Anderson" <sip:mdokeqt0@bnttdi537va5.invalid;transport=ws>` → `SIP/2.0 401 Unauthorized`, `REFER failed`. For an **incoming** session jssip builds the REFER's From from the dialog's local URI — the anonymous instance URI, not the extension AoR — so `transfer/handler.go:204 addressOfRecord(from.Address)` derives user `mdokeqt0`, challenges it, and no credential exists. In the caller orientation the same REFER carries `From: <sip:1201@rt2mtuiyokf.local.test>` and is answered `202 Accepted`.                                                                                                                                                                                                                                                                                                                                                                       | **FAIL** (web softphone, `apps/web/lib/softphone/jssip-adapter.ts`)                    |
| 6   | **Attended transfer, audio follows, CDR linkage**                               | Caller orientation: consult rang 1202 (+40 pkt during the consultation), `Complete transfer` → transferor dropped, 1203 +41 pkt, 1202 +40 pkt. Audio follows. **CDR linkage absent**: the two halves are separate `call_id`s (`61bd127e` 1201→1203, `ca94a4df` 1201→1202) with no shared call id and `related_call_id` null on both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **PASS** (audio) / **FAIL** (CDR linkage)                                              |
| 7   | **Call pickup `**<ext>` and `*8`, two-way audio**                               | Delta-measured (the browser's `getStats` sums every peer connection the tab ever made, so absolute counts carry the previous scenario — the first pass of this round was wrong for exactly that reason). `**1201`: rang 1201, 1202 **+192** pkt, 1203 **+192** pkt. `*8`: rang 1201, 1202 **+192**, 1203 **+193**. Original appearance stopped ringing. CDR: the picked-up call is a separate `call_id` from the original, whose B-leg is filed `no-answer`/0 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **PASS** (audio)                                                                       |
| 8   | **Engine adoption (two engines, kill the owner, billed CDR)**                   | `e2e-engine-2` started from source on 9301; both `/healthz` listed the other in `engine.livePeers`. `TestE2EHoldACallOpen` (90 s) landed on engine-2 (`activeChannels` 0 → 2). `kill -9` at **23:35:51** → `an engine replica stopped renewing its liveness lease {instanceId:"e2e-engine-2", why:"the lease expired"}` **23:36:05.945** → two `adopted a channel from an engine replica that died` **23:36:06.027/.028** → `finished contesting … candidates:2 adopted:2` — **14.2 s, 83 ms to install both**. Survivor `/healthz`: `peersLost: 1, channelsAdopted: 2`. Media never noticed: **4 549 packets each way, 0 lost** over 91 s; `BYE -> 200 OK`; both CDR legs billed **91.1 s** `answered`/`NORMAL_CLEARING` by the adopter.                                                                                                                                                                                                                                                                                                                       | **PASS**                                                                               |
| 9   | **Plane loss — kill mediad**                                                    | Held call, `kill -9 mediad` at **23:37:39** → `mediad stopped answering reachability probes; readiness is degraded` and `ending every leg on a plane that is gone {plane:"media", reason:"MEDIA_OWNER_LOST", count:4}` at **23:37:43.769**, `finished … ended:4 affected:4` at **.782** — **4.8 s to decide, 13 ms to end**. CDR: both legs `NORMAL_TEMPORARY_FAILURE` / **41**, `answered`, billed **25.7 s** (the time actually connected). `up.sh mediad` → `/healthz` 200; fresh `TestE2EPhoneToPhoneCall` **PASS** (4.0 s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **PASS**                                                                               |
| 10  | **Plane loss — kill sipd**                                                      | Held call, `kill -9 sipd` at **23:38:54** → `a sip edge stopped renewing its liveness lease {instanceId:"e2e-sipd-1", why:"the lease expired"}` + `ending every leg on a plane that is gone {plane:"signalling", reason:"SIP_OWNER_LOST", count:4}` at **23:39:08.032**, `ended:4 affected:4` at **.044** — **14.0 s**. CDR: both legs `NORMAL_TEMPORARY_FAILURE` / **41**, `answered`, billed **34.9 s**. `up.sh sipd` → `/healthz` 200, registrations rebuilt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **PASS**                                                                               |
| 11  | **Shared line seize / hold / retrieve / recall / release, lamp in KV**          | Line 4500, appearances 1202/1203, `holdRecallTimeoutSeconds` 15. **Seize PASS**: 1201 dials 4500 → both appearances ring → 1202 answers → `shared-line-state` key `<org>.<lineId>` rev 1 `state:"seized", heldByExtensionId:…a47b (1202), heldByAppearanceIndex:0, callId, legId`. **Hold PASS**: rev 2 `state:"held"`, `heldAtMs` stamped. **Retrieve FAIL**: 1203 dials 4500 → `shared line "…" is on hold and could not be retrieved: the leg has not answered, so it cannot be used for shared-line retrieve`, walk `status:"hangup"` — the retrieving leg is never answered before `sharedLineNode` evaluates it (`plan-walker.ts:4132-4145`). **Recall FAIL**: fired on time (hold ≈ 23:26:44, `a shared line's hold recall did not reach the appearance that held it {extensionNumber:"1202", status:"hangup"}` 23:26:59) but the appearance never rang. **Release PASS**: after hangups the bucket is empty (0 keys). Barge-in remains unimplemented (`bargeInEnabled: true` in the artifact; the walker rings the appearances as a new call instead).  | **PARTIAL** — 3 of 5                                                                   |
| 12  | **Queue callback end to end**                                                   | Provisioned queue **4610** in the routing2 org (`callbackEnabled`, `callbackKey "1"`, offer after 5 s, agent 1205). **Opt-in PASS**: `the caller accepted a callback by key after 9s; their place is held for 1201` and `the caller took the callback offer`. (Also: `the callback offer was due but the queue has no offer prompt; the caller was not told about the key` — the offer is silent without a prompt.) **Dial-back NOT PROVEN**: agent set `available`, watched 60 s twice — **no `rpc.engine.v1.queue-callback` request on the bus at all** (sniffed for 150 s), nobody rang, `related_call_id` still 0-populated. **Confounded**: a _control_ — an ordinary call to 4610 with the agent `available` — also never rang 1205, so the blocker is upstream of the dialler (the API's `queue-agents.status` field does not make this agent reachable; agent presence presumably needs the queue console or `*22`). There is also **no `GET /queues/:id/callbacks`** route (404), so a pending callback cannot be inspected.                           | **PARTIAL** (opt-in only)                                                              |
| 13  | **Hot-desk login/logout via feature code + PIN**                                | Not reachable, and **blocked in code**. (a) The routing2 org's artifact has 14 feature codes and neither `*31` nor `*32`; `DEFAULT_FEATURE_CODES` does seed them. (b) `plan-walker.ts:2330` requires `this.deps.channel.deviceId`, which is `aggregate.snapshot.variables.OPTIMIQ_DEVICE_ID` (`channel-orchestrator.service.ts:5187`) — and that variable is **stripped before it reaches the aggregate**, see §2. So no SIP endpoint, device-backed or not, can ever satisfy the `deviceId` precondition. (c) Nothing on this stack registers with a device row anyway (browser softphones and the load roster have none). The prior `hotdesk-proof.sql` proves only the DB rebind.                                                                                                                                                                                                                                                                                                                                                                            | **FAIL** (blocked, §2)                                                                 |
| 14  | **STIR/SHAKEN attestation columns from a trunk INVITE**                         | sipd's half is **perfect**. Raw carrier INVITE for DID `+15005550201` on the external profile carrying `P-Asserted-Identity: … ;verstat=TN-Validation-Passed` + `Identity: …;attest=A;origid=final2-origid-0001` → on the bus, `rpc.sip.v1.invite` carries `"attestation": {"level":"A","verstat":"tn-validation-passed","assertedIdentity":"…","origId":"final2-origid-0001","signed":true}` with `authentication:"trunk-acl"`. The call rang 1204, answered, two-way audio (84 pkt / energy 8 466). **The CDR columns stay empty** — `cdr.leg.write` for that A-leg carries no `sipAttestation`/`sipVerstat`/`sipOrigId` at all (full payload dumped), and `call_legs.sip_attestation`/`.sip_verstat` are still 0-populated. Second pass with `Privacy: id` + `attest=B`: same, and `from_number` correctly stayed `anonymous`. Root cause in §2.                                                                                                                                                                                                             | **FAIL** (stops in the engine)                                                         |
| 15  | **Recording pause/resume: one file, silence gap, pause intervals in metadata**  | **No product surface exists.** `pauseRecord` / `resumeRecord` are call-control verbs in `verbs/verb-executor.ts:571-578` and reachable **only** through `rpc.engine.v1.session-verb` (the programmable-session hub, `apps/api/src/session/session-hub.service.ts`). There is no feature code (`DEFAULT_FEATURE_CODES` has `*3 record-toggle`, no pause), no REST route (grep of every `*.controller.ts` for pause/resume + record: nothing), and no call-flow node. `recordings.pauses` remains **0 of 42** rows. The engine/mediad plumbing below the surface is complete (`call-control.ts:2707`, `mediad-media.port.ts:645`, `mediad-event-mapping.ts:141`, `recording.finished.pauses`).                                                                                                                                                                                                                                                                                                                                                                    | **NOT RUN — no reachable surface**                                                     |
| 16  | **Park, both orientations, on the restarted engine** (`PARK-FIX-READY` present) | Engine restarted at 23:41 to pick the fix up. **Half fixed**: `parkedByNumber` is now the **presser** in both orientations (A: 1201 presses → `parkedByNumber:"1201"`; B: 1203 presses → `"1203"`, the exact inversion `E2E-final.md` §2 recorded), and the packet deltas say the **peer** is the one in the orbit (A: other 330 vs presser 272; B: other 334 vs presser 267). **Recall still broken, both orientations**: `a timed-out parked call could not be returned to its parker … status:"hangup"` at 23:42:17 (A) and 23:43:29 (B). **And now the reason is visible**: in the same millisecond the engine logs `filed a voicemail message` into the **parker's own mailbox** — `01a087c7-ef7e` (1201's) in A, `01a087c7-f061` (1203's) in B, 21.4 s / 21.3 s. The recall _does_ route to the parker; it lands in their voicemail because `*5` never releases the presser's own leg (their packet count keeps growing after the park), so the extension is occupied and the ladder falls through.                                                       | **FAIL** — who-is-parked and who-is-recorded now correct; the recall still never rings |

**Counts: 8 PASS · 2 PARTIAL · 6 FAIL · 1 NOT RUN (no surface).**
(Rows 5/5b and 6 each split; counted as: 1 PASS + 1 FAIL, and 1 PASS-with-a-FAIL respectively.)

---

## 2. The one root cause behind three of the failures

`channel-orchestrator.service.ts:1089` builds an aggregate's variables from
`readEngineVariables(channel)`, which is an **allow-list of seven names** (`:4193-4207`):
`OPTIMIQ_ORG_ID`, `OPTIMIQ_CALL_DIRECTION`, `OPTIMIQ_ROUTING_CONTEXT`, `OPTIMIQ_LEG`,
`OPTIMIQ_SIP_CALL_ID`, `OPTIMIQ_SIPD_INSTANCE_ID`, `OPTIMIQ_REPLACES_LEG_ID`.

`invitedChannelSnapshot` (`:4907-4947`) stamps **four more**: `OPTIMIQ_DEVICE_ID`,
`OPTIMIQ_SIP_ATTESTATION`, `OPTIMIQ_SIP_VERSTAT`, `OPTIMIQ_SIP_ORIGID`. Every one of them is
dropped at `:1136-1140`:

```ts
const variables = await this.readEngineVariables(channel);   // 7 names, allow-listed
…
const aggregate = ChannelAggregate.create({ …, variables: { ...definedOnly(variables), … } });
```

So `attestationOf(aggregate.snapshot.variables)` at the CDR write (`:3707`) can never see anything
(row 14), and `get deviceId()` (`:5186`) can never return anything (row 13). The doc comment at
`:4890` — _"Every one of the five variables `readEngineVariables` looks for is stamped here"_ — is
the tell: the stamping side grew four fields the reading side never learned about.

**Minimal fix**: build the aggregate's variables from `channel.variables` (or add the four names to
the allow-list, which is a one-line-per-name change and keeps the port-read fallback semantics).
Left as a finding — it is a change in the engine's arrival path and the brief reserves non-trivial
changes.

**Adjacent, one line further**: `sipCallId` is in the allow-list, indexed by the dialog registry, and
**never written to the CDR** — `cdr-leg.ts` has no `sipCallId` field at all (only
`cdr/query/cdr.repository.ts:77` reads the column). `call_legs.sip_call_id` is 0-populated across all
15 220 rows, so no CDR can be correlated with a carrier's Call-ID.

---

## 3. Everything still failing, with the exact symptom and the layer

1. **P1 — the engine's variable allow-list eats four stamped variables.** §2. Victims: STIR/SHAKEN
   CDR columns (row 14), hot-desk (row 13), and `E2E-final.md`'s row 15 (`deviceId` on invites).
2. **P1 — early media is never relayed.** sipd publishes `dialog.progressed status=183
hasEarlyMedia=true sdpAnswer=<present>`; the caller gets no 183 and no pre-answer audio, and
   `relayEarlyMedia` (`channel-orchestrator.service.ts`) returns without logging. Add a log line on
   the `originator === undefined` return — its silence is why this took a wire capture to find.
3. **P1 — blind transfer is impossible for the party who ANSWERED the call.** `jssip-adapter.ts`
   sends the REFER with the anonymous instance URI as its From on an incoming session; sipd
   challenges an account that does not exist and the phone reports "refused". Works in the caller
   orientation. Fix belongs in the web softphone (force the AoR on `session.refer`).
4. **P1 — the park timeout recall lands in the parker's voicemail.** `*5` now parks the right party
   and records the right parker, but does not release the presser's leg, so the recall reaches a
   busy extension. Row 16.
5. **P1 — shared-line retrieve refuses because the retrieving leg is unanswered**
   (`plan-walker.ts:4132-4145`), and the hold recall ends `status:"hangup"` without ringing. Same
   _shape_ as the park recall — both are "recall dial ends hangup" — and worth one investigation.
6. **P1 — CLIR restricted is unreachable.** Both edges implemented; no field, column, artifact key,
   API surface or feature code in between, and `plan-walker` (the path a phone actually takes)
   never carries it. `FIX-clir.md` cross-area 1-4 open.
7. **P2 — attended-transfer CDR halves are not linked.** Two `call_id`s, `related_call_id` null.
8. **P2 — recording pause/resume has no reachable surface.** Row 15.
9. **P2 — a queue agent set `available` over the API never becomes reachable.** Proved by a control
   call, not just by the callback path; it blocks any assertion about the callback dialler.
   Also `GET /api/v1/queues/:id/callbacks` does not exist (404).
10. **P2 — `4600` was refused as ambiguous** against the routing2 dial-by-name (`RT2 Directory`),
    which is the write-time compile check working. Queue moved to 4610. Not a defect.
11. **Note — the browser softphone's `getStats` is cumulative per tab.** Any harness that reads
    absolute `packetsReceived` after a `settle()` reports the _previous_ scenario's audio. The first
    pass of row 7 passed for this reason before being re-measured as a delta. Worth fixing in
    `routing2/lib.mjs`'s `inboundAudio`/`audioFlowing`.
12. **Note — outbound trunk audio was intermittent** across three runs of the same carrier script
    (one control run gave the browser 149 packets and the carrier 0; another gave the browser 0 and
    the carrier 312). Not chased down; the early-media verdict does not rest on it (that claim is
    "no 183 and zero pre-answer audio", reproduced twice).
13. **Note — engine `activeChannels` settles at 2, not 0**, exactly as `FIX-engine-adoption.md`'s
    "honest residue" describes. It survived every drill and inflated three `count:` fields in the
    plane-loss logs above (`count:4` = 2 live + 2 phantom).

---

## 4. Resilience timings, side by side with the earlier claims

| Drill                               | This run                                 | `FIX-*.md` claim |
| ----------------------------------- | ---------------------------------------- | ---------------- |
| engine kill → both channels adopted | **14.2 s** (lease 15 s)                  | 12.3 s           |
| adopted call's CDR                  | **91.1 s billed, both legs, 0 RTP lost** | 91.1 s, 0 lost   |
| mediad kill → decision              | **4.8 s**, `MEDIA_OWNER_LOST`, cause 41  | 1.3 s, cause 41  |
| sipd kill → decision                | **14.0 s**, `SIP_OWNER_LOST`, cause 41   | (lease-driven)   |
| fresh call after each restart       | PASS                                     | PASS             |

---

## 5. What was NOT run, and why

- **Recording pause/resume against mediad** — the verb exists but only behind the programmable
  session hub; standing up a session app was out of scope for this round. The mediad half
  (`pauses` on `recording.finished`) is therefore still unproven live.
- **The 1 000-attempt credential spray** (`E2E-final.md` row 5) — still owed, untouched here.
- **Barge-in on a shared line** — unimplemented; the walker says so in a note.
- **CLIR restricted end to end** — no way to trigger it (row 3). Not simulated by hand-editing the
  artifact KV, because a compile would overwrite it and the result would prove sipd only, which
  `originate_internal_test.go` already does.

---

## 6. Source touched — test-only, nothing committed

| File                                        | Change                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/sipd/e2e_sdes_test.go`                | **new**, build tag `e2e`: `TestE2ESDESOverTLS`, `TestE2ESDESKeyDerivationMatchesRFC3711`.                                                                                           |
| `apps/sipd/internal/testutil/sipua/srtp.go` | **new**: AES_CM_128_HMAC_SHA1_80 over stdlib AES-CTR + HMAC-SHA1, an SDES offer builder and an `a=crypto` parser. No new module dependency (`go.mod` untouched).                    |
| `apps/sipd/internal/testutil/sipua/rtp.go`  | two hooks: `SetInspector` (decrypt / raw capture on receive, plus an `Undecodable` stat) and `SetProtector` (encrypt on send, clearable mid-call to stage the plaintext downgrade). |

`gofmt` clean, `go vet -tags e2e ./...` clean. No production file was edited by this round.

Run:

```sh
P1601=$(node -e 'import("<sp>/load/derive.mjs").then(m=>console.log(m.derive("secret://sipe2e/1601")))')
P1602=$(node -e 'import("<sp>/load/derive.mjs").then(m=>console.log(m.derive("secret://sipe2e/1602")))')
cd apps/sipd && SIPD_E2E=1 SIPD_E2E_PASS_1601=$P1601 SIPD_E2E_PASS_1602=$P1602 \
  SIPD_E2E_ARTIFACTS=<sp>/e2e/artifacts/sdes \
  go test -count=1 -tags e2e -run 'TestE2ESDES' -v -timeout 5m .
```

---

## 7. Left on the stack

- **Restarts I performed** (all logged in `STACK.md`): `mediad`, `sipd` (both killed as the drill and
  brought back with `up.sh`), `engine` (twice — once as the adoption drill's survivor, once at 23:41
  to pick up the park fix). A second engine `e2e-engine-2` was started on 9301 and **killed**; it is
  gone. One engine, one sipd, one mediad, all `/healthz` 200.
- **Data I created, in my own (routing2) org only**: queue **"RT2 CB Queue"** on extension number
  **4610** with queue-agent **"RT2 CB Agent 1205"** and one tier; one pending queue-callback opt-in
  for 1201. Six carrier calls to DID `+15005550201` and five outbound calls to `1555123000x`. No
  other agent's data was read or written.
- **Harnesses** in `<scratchpad>/e2e/final2/`: `sip.mjs` (raw UDP SIP + RTP + µ-law tone/energy),
  `carrier.mjs` (fake carrier UAS, `MODE=answer|early`, header capture), `attest.mjs`, `dialout.mjs`,
  `sniff.mjs` (subject tap as the operator credential), `transfer.mjs`, `transfer2-5.mjs`,
  `sharedline.mjs`, `sl-recall.mjs`, `qcb-provision.mjs`, `qcb.mjs`, `qcb-ctrl.mjs`, `parkboth.mjs`.
- **Artifacts** in `<scratchpad>/e2e/artifacts/final2/` (invite/CDR/dialog wire dumps, carrier logs,
  early-media sample series, transfer log) and `<scratchpad>/e2e/artifacts/sdes/`.
- `<scratchpad>/e2e/PARK-FIX-READY` was consumed (row 16) and **left in place** — I did not create it
  and it records another agent's state.
- No database was reset. No `LOAD-RUNNING` was taken.
