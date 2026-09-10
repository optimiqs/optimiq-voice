# E2E-final6 — the `related_call_id` re-drive on a restarted engine

2026-09-10 02:48 → 02:52 UTC. Sole owner of the stack for the round. **No application code
changed** (`git status` is `?? output/` at start and at hand-off). Stack left running and green.

Scope: the one FAIL carried out of `E2E-final5` — **H1, the queue callback's `related_call_id`
never reaching the ledger**. The fix (one entry, `CDR_RELATED_CALL_ID_VARIABLE`, on
`ARRIVAL_VARIABLES` at `apps/engine/src/calls/channel-orchestrator.service.ts:211`) was already in
the tree; the engine runs from `src` under `@swc-node`, so only a restart was owed.

---

## 1. Restart round — engine only

| Item                       | Evidence                                                                                                                                                                                                                                            | Verdict  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Restart                    | `kill $(cat pids/engine.pid)` 02:48:55 → `up.sh engine` 02:48:57. New pid **64716** (was 51516). No build owed — the engine starts from `src`. No other service touched, no NATS reload, no migration.                                              | **PASS** |
| `/healthz` 200             | engine `:9300` **200**, `status: ok`, `activeChannels: 0`, `media.driver mediad ready:true`. Every other service still 200 (`status.sh`: postgres, nats, smtp, mediad 9291, sipd 9290, api 3200, web 3300).                                         | **PASS** |
| `/metrics` 200             | `:9200` api, **`:9201` engine**, `:9290` sipd, `:9291` mediad — all **200**.                                                                                                                                                                        | **PASS** |
| Zero new broker violations | **1009 before, 1009 after** the whole round (restart + G3 + two smoke calls). Broker users `sipd 1, mediad 1, engine 2, api 24`.                                                                                                                    | **PASS** |
| No new WARN+ class         | Engine WARN+ since the restart is **2 lines**: the `ENGINE_MEDIA_DRIVER=mediad` boot banner and one `refusing an agent state transition {reason:"not-engine-driven"}` — the probe's own `session/logout`. Both are the known set from `E2E-final5`. | **PASS** |

---

## 2. G3 re-driven — `final3/qcb-session.mjs`, verbatim

Same probe, same fixtures (`final3/qcb.json`: queue `01a08880-b810-770d-80fd-e4676be6d694`,
agent `01a08880-b83c-726f-b3d2-97fd45e94b8b` "RT2 CB Agent 1205", org
`01a087c3-8c47-7605-9aee-fad39690fb96`). Run 02:49:22 → 02:49:50 UTC. `errors: {"1201":[],"1205":[]}`.

| #         | Item                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Verdict  |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| **G3a**   | Opt-in, dialled, connected                         | Agent logged out first; 1201 dials 4610, waits 9 s, presses `1`: **`callActive=true`**. Agent `POST /queue-agents/:id/session/login` → **201 `available`**. Then **`firstRang=1201 secondRang=1205 1201Active=true 1205Active=true`**. Engine 02:49:42.652 `placed a queue callback` — `callbackId/legId 01a08938-97eb-70f6-8fd8-607de5d749a1`, `callId 6dfc4a29-4738-3bb0-aa37-51b35e96a0f2`, **`relatedCallId "a8b16826-e36f-363d-866a-0c3e7a6ddd41"`**.                                                                           | **PASS** |
| **G3b**   | `GET /api/v1/queues/:id/callbacks` lists the token | **200**, `{"data":[{"callerNumber":"1201","joinedAt":1789007727868,"priority":0,"abandonedAt":1789008572629,"expiresAt":1789012172629,"attempts":0,"maxAttempts":3,"nextAttemptAt":0,"callId":"a8b16826-e36f-363d-866a-0c3e7a6ddd41"}]}` — the token's `callId` is the abandoned waiting call, and it is the same value the placement then stamps.                                                                                                                                                                                   | **PASS** |
| **G3c**   | **`related_call_id` on the callback's legs**       | **NOW SET.** `optimiq_cdr.call_legs`, three rows: the waiting call `a8b16826-…` (leg `a`, 1201→4610, `queue`, `NORMAL_CLEARING`, 9 034 ms) with `related_call_id` null as it should be; the callback A-leg **`01a08938-97eb-70f6-8fd8-607de5d749a1`** under `call_id 6dfc4a29-…`, 4610→4610, **`related_call_id = a8b16826-e36f-363d-866a-0c3e7a6ddd41`** — exactly the abandoned call; and the callback B-leg `01a08938-98b3-…` (4610→1205), `related_call_id` null. Both callback legs `NORMAL_CLEARING`, 4 121 / 3 905 ms billed. | **PASS** |
| **Leak**  | `activeChannels` back to 0                         | **0** immediately after the probe, and **0** at hand-off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **PASS** |
| **Smoke** | Smoke call                                         | `MAIL_DIR=<scratchpad>/e2e/mail node .scripts/local-stack/smoke-call.mjs` — **9/9 PASS**: fresh org + realm, mail verification, both softphones over WSS, caller 23 pkt / callee 23 pkt, hold+resume renegotiated both ways, hangup propagated, 2 CDR legs.                                                                                                                                                                                                                                                                          | **PASS** |

**5 PASS · 0 FAIL. H1 is closed.**

### On the B-leg being null — this is correct, not a residual half of H1

`E2E-final5`'s H1 wrote "null on **both** callback legs". Only the A-leg is supposed to carry it.
`invitedChannelSnapshot` (line ~5379) stamps `[CDR_RELATED_CALL_ID_VARIABLE]: undefined` with the
comment _"Only an originated leg (queue callback, click-to-call) carries one; it arrives stamped"_ —
the variable is a property of the leg the platform originated towards the customer, and the agent
B-leg is an ordinary queue dial. The two legs are already joined by their shared `call_id`
`6dfc4a29-…`, so the ledger link from the callback to the abandoned call is complete and
unambiguous at call level.

---

## 3. What I changed on the stack

- **No application code**, nothing committed, staged or stashed.
- Restarted **engine only** (pid 51516 → 64716). sipd, mediad, api, web, nats, postgres, smtp untouched.
- Data: the probe's own opt-in for 1201 was consumed by the callback it triggers; the queue agent
  was logged out by the probe's `finally` and is `logged-out`, as it was before the round. Nothing
  else in org `01a087c3-…` was written.
- **Two smoke runs** (the first was re-run only to capture its PASS lines) left orgs
  `01a08939-7c68-772d-857f-9b93ae529401` / realm `smokemtuxjy1z.local.test` and one earlier sibling
  with their users, as the script intends (extensions cleaned up). Both are deletable.
- No new probe script and no new capture directory was needed.

## 4. Stack state at hand-off

All eight services green — `postgres`, `nats` (55950), `smtp` (94405), `mediad` (9291, pid 51435),
`sipd` (9290, pid 14478), **`engine` (9300, pid 64716)**, `api` (3200, pid 51577), `web` (3300, pid
88976). `/metrics` 200 on `:9200 :9201 :9290 :9291`. Engine `status: ok`, `activeChannels: 0`.
Broker: `sipd 1`, `mediad 1`, `engine 2`, `api 24`; permission violations **1009**, unchanged from
the start of the round.

**Carried forward unchanged, not re-driven:** F3 (hot desking needs a device-backed endpoint), F10
(ten `admmtub*`/`admmtuc*` fixture trunks with `auth_user=''`; sipd was not restarted), and the
cosmetic `api.cdr` `destinationType` coercion WARNs.
