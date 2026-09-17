# E2E-final5 — G1–G5 re-drive on the committed fixes

2026-09-10 02:33 → 02:45 UTC (2026-09-09 21:33 → 21:45 CDT). Sole owner of the stack for the round.
**No application code changed.** Stack left running and green.

The G1–G5 work is **committed**, not left in the working tree as `FIX-final4.md`'s handover block
warned: `1cb18a6` (api/web — the callbacks route, the `active-calls` grant) and `eb8e6d7`
(engine/mediad — the transfer and shared-line seams, callback leg registration, pre-answer media).
The tree at `eb8e6d7` was clean apart from an untracked `output/`.

Probes reused verbatim from `<scratchpad>/e2e/{final2,final3,final4,routing2}/`; new captures under
`<scratchpad>/e2e/final5/`.

---

## 1. Restart round — mediad → engine → api

| Item                               | Evidence                                                                                                                                                                                                                                                                                                                                        | Verdict  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Restart order and rebuild          | `kill` all three, then `up.sh mediad` (which re-ran `[stack] building the Go services`, refreshing `bin/mediad` and `bin/sipd`), `up.sh engine`, `up.sh api`. New pids **mediad 51435, engine 51516, api 51577**. `sipd` (14478) and `web` (88976) deliberately left up — sipd is untouched by both commits and `next dev` picks web up itself. | **PASS** |
| No NATS reload / no migration owed | `config/nats.conf` and `packages/*` untouched by both commits; the api already holds the `queue-waiting` grants the new client needs. Nothing reloaded, nothing migrated.                                                                                                                                                                       | **PASS** |
| `/healthz` 200                     | mediad `:9291`, sipd `:9290`, engine `:9300`, api `/api/auth/ok`, web `:3300`, nats `:8322` — **all 200**                                                                                                                                                                                                                                       | **PASS** |
| `/metrics` 200                     | `:9200` api, `:9201` engine, `:9290` sipd, `:9291` mediad — **all 200**                                                                                                                                                                                                                                                                         | **PASS** |
| Zero new broker violations         | `status.sh` **1009 before, 1009 after** the whole round.                                                                                                                                                                                                                                                                                        | **PASS** |
| Broker users                       | `sipd 1, mediad 1, engine 2, api 24`. (The pre-restart `engine 3` was a dead `engine2b.pid` from an older round; it is gone.)                                                                                                                                                                                                                   | **PASS** |
| No new WARN+ class at boot         | **Zero** WARN/ERROR in mediad's, engine's or api's log between the restart and the first probe. Engine `status: ok`, `activeChannels: 0`, `media.driver mediad ready:true`, `sipd.selected true`, `liveInstances ["e2e-sipd-1"]`.                                                                                                               | **PASS** |

---

## 2. The re-drive

| #          | Item                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verdict  |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **G1**     | **Blind transfer initiated by the party who ANSWERED**                                                         | `final3/blind-answerer.mjs`. 1203 dials 1201; 1201 answers; 1201 REFERs to 1202. Result: `refusalBannerShown:false`, **`rang:"1202"`**, `transferorDropped:true`, **`delta1202:40` / `delta1203:41` inbound RTP packets** — audio follows to the new pair. `BLIND-BY-ANSWERER PASS`, no page errors on any of the three tabs. The `transfer_failed … the routing walk ended the call` line the last round saw does not appear.                                                                                                                                                                                                                                                                                                                          | **PASS** |
| **G1-cdr** | **The transfer is linked in the ledger**                                                                       | Three `call_legs` rows under **one `call_id` `43cfb2d1-…`**: A-leg `01a0892a-579a…` (1203→1201, `internal`, `bridge_leg_id` → the post-transfer B-leg); the pre-transfer B-leg `01a0892a-57ae…` (1203→1201) closed **`hangup_cause BLIND_TRANSFER`**, `originating_leg_id` → the A-leg; the post-transfer B-leg `01a0892a-622e…` (1203→**1202**, 9 170 ms, answered), `originating_leg_id` and `bridge_leg_id` both → the A-leg. **`sip_call_id` non-null on all three.**                                                                                                                                                                                                                                                                               | **PASS** |
| **G2**     | **Shared line 4500: hold → retrieve from another appearance → hold again → recall reaches the seizing device** | `final3/sl-retrieve.mjs`. Seize `LAMP[seized] state=seized ext=…acda`; hold `LAMP[held] ext=…acda`; 1203 retrieves 6 s later — **192 inbound RTP packets**, `RETRIEVE PASS`; **`LAMP[after-retrieve] state=seized ext=…e710`** — the lamp now names the RETRIEVING appearance where the last round still read `…acda`. 1203 then holds and **`RECALL rang=1203 after 15s expected=1203 -> PASS`**. (The `legId` stays `c19cc1`, the caller's leg — deliberate per `FIX-final4` G2, since `releaseSharedLine`/`recallSharedLine` resolve the caller from it.)                                                                                                                                                                                            | **PASS** |
| **G3a**    | **Queue callback to an internal caller: opt-in, dialled, connected**                                           | `final3/qcb-session.mjs`. Opt-in `callActive=true` (`the caller accepted a callback by key after 9s; their place is held for 1201`); agent `POST /queue-agents/:id/session/login` → **201 `available`**; then **`firstRang=1201 secondRang=1205 1201Active=true 1205Active=true`**. Engine: `placed a queue callback` with `callId 9c46361d…`, `legId 01a0892b-d753…`, **`relatedCallId "fb713ed7-…"`** — the `SplitPlaneLegStateError: the leg is not registered` / `refused a queue callback {reason:"extension_offline"}` triple of the last round is **gone**. CDR: 2 legs under `9c46361d…` (`4610→4610` a-leg, `4610→1205` b-leg), both `NORMAL_CLEARING`.                                                                                        | **PASS** |
| **G3b**    | **`GET /api/v1/queues/:id/callbacks` lists the pending token**                                                 | **200**, `{"data":[{"callerNumber":"1201","joinedAt":1789007727868,"abandonedAt":1789007736893,"expiresAt":1789011336893,"attempts":0,"maxAttempts":3,"nextAttemptAt":0,"callId":"fb713ed7-11d1-37b5-a807-e9571b58ed7b"}]}` — was **404** last round.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PASS** |
| **G3c**    | **`related_call_id` set on the callback leg**                                                                  | **NOT SET.** `call_legs.related_call_id` is **null** on both callback legs, although the engine logged `relatedCallId:"fb713ed7-…"` on the placement 100 ms earlier and `fb713ed7…` is exactly the abandoned call's `call_id`. See **H1**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **FAIL** |
| **G4a**    | **Early media, SIP-UA caller (non-WebRTC)**                                                                    | `final4/sipua.mjs` (EXT 1204, digest REGISTER 200) against `final4/carrier2.mjs` `MODE=early EARLY_MS=20000`. Responses: `100 @2ms`, `180 @6ms`, **`183 with SDP @169ms`**, `200 with SDP @21 139ms`. **`firstInboundPacketAtMs 403`**, **`preAnswerPackets 996`, `preAnswerEnergy 37 271.78`** — inbound packets AND energy > 0 for the whole 20 s, where the last round measured 0/0. After the 200: `finalPackets 1299` (**+303**), `finalEnergy 48 586.7`. Carrier: `183 sent; streaming early tone to 127.0.0.1:32022` → `200 sent after early media` → `post-answer tone done`.                                                                                                                                                                   | **PASS** |
| **G4b**    | **Early media, browser caller**                                                                                | `final2/dialout.mjs` from 1201, same carrier/mode. First audio at **852 ms** while `active:false`; **53 consecutive pre-answer samples**, last one `t=21 080ms packets=991 energy=2.70`; the call flips `active:true` at `t=21 484ms` (the 200) and grows to `packets=1299` by `t=29 964ms` (**+288 after the answer**). **Byte-for-byte the same shape as the SIP UA** — both caller types now hear the announcement.                                                                                                                                                                                                                                                                                                                                  | **PASS** |
| **G4c**    | **mediad bridges at the 183, not only at the 200**                                                             | `logs/mediad.log`: `session allocated (B, port 32022)` → `session codec settled (B)` → `session allocated (A, port 32024)` → **`sessions bridged bridgeId:"early-01a0892d-928d-…"`** at **21:37:40.535**, i.e. ~166 ms after the INVITE — then at the 200, `session codec settled (B)` and **`sessions bridged bridgeId:"01a0892d-e522-…"`** (the walk's own id) at 21:38:01.507. The `early-…` bridge is replaced, not left behind.                                                                                                                                                                                                                                                                                                                    | **PASS** |
| **G4d**    | **The caller is not reaped during a 20 s announcement**                                                        | Both callers' packet counts grow monotonically across the full 20 s (996 / 991 samples above) and the call completes on the 200. **No reap of the caller's session during early media** in `logs/mediad.log`; the only `reaped idle sessions` line (21:38:40) is 39 s later and is the harness UA's own post-BYE silence.                                                                                                                                                                                                                                                                                                                                                                                                                               | **PASS** |
| **G4e**    | **Early media is not billed**                                                                                  | CDR for the UA call: `started_at 02:37:40.368`, **`answered_at 02:38:01.506`** (the 200, not the 183), `duration_ms 59 907`, **`billsec_ms 38 769`** — the 21 s of early media is in duration and out of billsec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **PASS** |
| **G5**     | **Softphone shows the recording indicator and pause/resume for a `calls.control` holder**                      | 1201's membership promoted `user` → `admin` (the only shipped template holding `calls.control`; there is no custom-role surface), then `final3/recording.mjs`. **`indicator=true pauseButton=true`** — both `false` last round. Live `channels` row `flags:["answered","recording"]`; `POST /calls/:id/recording/pause` **200** `{paused:true}` → row `flags:["answered","recording","recording-paused"]` → the softphone renders **`Recording paused`** (`true`); `…/resume` **200** `{paused:false}`. One recording object, `kind:"call"`, `durationMs 14 060`, `sizeBytes 225 004`. Role restored to `user` and 1202's `recordPolicy` restored to `none` afterwards. The last round's `user`-role FAIL is the documented empty-feed case, unchanged. | **PASS** |
| **Smoke**  | **Smoke call**                                                                                                 | `MAIL_DIR=<scratchpad>/e2e/mail node .scripts/local-stack/smoke-call.mjs` — **9/9 PASS** (fresh org + realm `smokemtux9ali.local.test`, mail verification, both softphones over WSS, caller 23 pkt / callee 24 pkt, hold+resume renegotiated both ways, hangup propagated, 2 CDR legs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **PASS** |
| **Leak**   | **`activeChannels` back to 0 after each scenario**                                                             | Read **0** after G1, after G2, after G3, after each G4 leg, after G5 and at hand-off. One caveat, harness-side: after G4a the count sat at **2 for ~40 s** because `final4/sipua.mjs`'s BYE does not match its dialog, so the leg closed on `MEDIA_TIMEOUT` instead — the same shape the last round's 02:01 run left. The platform released it on its own with no intervention (last round the final3 agent had to delete stale KV keys by hand; this round nothing was deleted).                                                                                                                                                                                                                                                                       | **PASS** |

### Counts

**14 PASS · 1 FAIL** across the 15 re-driven items (the restart round adds 7 further PASS).

**Closed since `E2E-final4`:** G1 (blind transfer by the answering party, with the CDR link), G2
(both halves — the lamp and the re-armed recall), G3's engine registration and the callbacks route,
G4 in full (both caller types, both directions, the early bridge, the reaper, the billing rule) and
G5 (the indicator and the pause control).

---

## 3. Remaining failure, pinned to a layer

**H1 — the queue callback's `related_call_id` never reaches the ledger.** `P2`, **`apps/engine`**,
`apps/engine/src/calls/channel-orchestrator.service.ts`. `placeQueueCallbackCall` builds
`OPTIMIQ_CDR_RELATED_CALL_ID` correctly and passes it both to the synthetic `onLegArrived` (line
~5044) and to `media.originate`'s `variables` (line ~5088) — the placement log line proves the value
is right. It is dropped at the READ side: `readEngineVariables` (line 4563) returns
**`ARRIVAL_VARIABLES` and nothing else** — its own doc says "whatever this method returns is what
lands on the aggregate and in the `channels` bucket" — and that array (line 198) lists
`OPTIMIQ_ORG_ID`, `OPTIMIQ_CALL_DIRECTION`, `OPTIMIQ_ROUTING_CONTEXT`, `OPTIMIQ_LEG`, the SIP
call-id / instance / replaces / device / attestation names, and **not**
`OPTIMIQ_CDR_RELATED_CALL_ID`. So the CDR write at line 4055 reads
`aggregate.snapshot.variables[CDR_RELATED_CALL_ID_VARIABLE]` as `undefined` and omits the field.
The fix is one entry on `ARRIVAL_VARIABLES` (the array is deliberately the single source for both
the stamp and the read, so adding it there is the whole change). Pre-existing rather than caused by
`eb8e6d7` — it was simply unobservable while every callback was refused before it dialled. The same
allow-list would drop the variable on the click-to-call path, which sets it too.

**Cosmetic, carried forward.** `api.cdr` logs `destinationType` coercions at WARN — `shared-line` →
`unknown` (G2's legs) and `trunk-dial` → `trunk` (G4's legs) — the same family as the
`feature-code` → `unknown` note in `E2E-final4` item 13: the engine names a destination the CDR
column's enum does not carry. `apps/api/src/cdr/writer/cdr-leg-mapping.ts` or the engine's naming,
either side; no functional effect.

**Carried forward unchanged and not re-driven:** F3 (hot desking needs a device-backed endpoint),
F10 (the ten `admmtub*`/`admmtuc*` fixture trunks with `auth_user=''`, still ten ERROR lines at
every sipd boot — operator data cleanup, and sipd was not restarted this round).

---

## 4. What I changed on the stack

- **No application code.** Nothing committed, staged or stashed; `git status` is
  `?? output/` at start and at hand-off.
- Restarted **mediad**, then **engine**, then **api**. `up.sh mediad` also rebuilt `bin/sipd`; the
  running sipd process (14478) was not restarted and is unaffected.
- Data, all restored: 1201's membership role was promoted `user` → `admin` for G5 and **restored to
  `user`**; 1202's `recordPolicy` was set `all` by `recording.mjs` and **restored to `none`** by its
  own `finally` (verified `none` afterwards); the queue agent was logged out at the end by the
  probe's own `finally`.
- The two smoke runs left orgs `01a08931-cd…` and `01a08931-e72f-765a-8e37-8740141c9b76` / realm
  `smokemtux9ali.local.test` with their users, as the script intends (extensions cleaned up). The
  first run was re-run only to capture its PASS lines; both are deletable.
- New captures under `<scratchpad>/e2e/final5/`: `inv-ua-early.json`, `inv-web-early.json`,
  `carrier-ua-early.log`, `carrier-web-early.log`, `dialout-web-early.json`, `marks`. No new probe
  script was needed — every harness came from `final2`/`final3`/`final4`.
- **My own trivial breakages:** one `python3 json.loads` on `dialout.mjs`'s output failed because
  the file carries a trailing `errors:` line after the JSON; re-parsed with `raw_decode`. No service
  was touched by it. Nothing else broke.

## 5. Stack state at hand-off

All eight services green — `postgres`, `nats`, `smtp`, `mediad` (9291, pid 51435), `sipd` (9290,
pid 14478), `engine` (9300, pid 51516), `api` (3200, pid 51577), `web` (3300). `/metrics` 200 on
`:9200 :9201 :9290 :9291`. Engine `status: ok`, `activeChannels: 0`. Broker: `sipd 1`, `mediad 1`,
`engine 2`, `api 24`; permission violations **1009**, unchanged from the start of the round.
Since the restart: engine 3 WARN (the mediad-driver banner, one `refusing an agent state change
{reason:"not-engine-driven"}` from the probe's own logout, one `unknown_dialog` on a hangup that
released media anyway and still filed a clean CDR), mediad 3 WARN (the harness UA's post-BYE
silence and its reap), api 7 WARN (all the `api.cdr` `destinationType` coercions above). **No new
WARN class.**
