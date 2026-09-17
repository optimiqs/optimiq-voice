# E2E-review-live — the REVIEWFIX wave re-driven on the running stack

**2026-09-10 03:18 → 03:45 UTC.** Sole owner of the stack for this round. sipd and mediad were
rebuilt from the working tree (which carries REVIEWFIX-A…E, uncommitted) and restarted; every
finding below was then re-driven against the real sipd, mediad, engine and broker on their real
sockets. **No application code was changed.** Nothing was committed, staged or stashed.

## 1 · Rebuild and restart

| Step              | Detail                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- |
| sipd              | killed 22:18:34 CDT, `up.sh sipd` rebuilt both Go binaries and restarted it; up 22:18:41     |
| mediad            | killed 22:18:54 CDT, `up.sh mediad` rebuilt and restarted; up 22:18:57                       |
| NATS reload       | **not owed** — `config/nats.conf` untouched by this wave, and neither service refused a knob |
| Migration         | **not owed** — no schema change in the wave                                                  |
| `/healthz`        | sipd `:9290` **200**, mediad `:9291` **200** (engine `:9300` and api 200 throughout)         |
| `/metrics`        | sipd `:9290` **200**, mediad `:9291` **200** (`:9200` api, `:9201` engine 200)               |
| Broker violations | **1009 before, 1009 after — zero new.** `logs/nats.log` unchanged at 1 449 lines             |
| Broker users      | four distinct authenticated users: `sipd 1, mediad 1, engine 2, api 24`                      |

**Boot WARN+ in the first minute — the known set only, nothing new.**

- sipd: the **ten** `ignoring an invalid trunk record … a registering trunk needs an auth user`
  ERRORs (the standing fixture-data finding from `E2E-final.md` §1), the
  `SIPD_PROVISION_SECRET_KEY` advice, the pprof notice, one
  `reaping the dialogs a previous incarnation of this instance id left behind` (count 6, the boot
  sweep doing its job), and one `UDP ref went negative on try close` logged by the **outgoing**
  process during its own shutdown.
- mediad: **zero** WARN+ at boot.
- engine, api: zero WARN+.

One cosmetic drift noticed and **not** fixed (no application code changed): mediad's `mediad is up`
banner lists 13 `subjects` and omits `rpc.media.v1.pause-recording`, which `control.go:246` does
register and which answered every request in the R01 run below. The banner literal has drifted from
the handler table.

## 2 · Re-drive

All Go probes live in `apps/sipd/e2e_review_live_test.go` (`//go:build e2e`, new, test-only) plus one
test-helper addition, `RTPSender.SendTonePaced` in `internal/testutil/sipua/rtp.go` — the knob that
lets a probe put 30 ms packets on the wire. Run with:

```sh
cd apps/sipd && SIPD_E2E=1 SIPD_E2E_ORG=01a08708-4cd4-76b9-b56d-d26ebf326b0a \
  SIPD_E2E_PASS_1601=… SIPD_E2E_PASS_1602=… SIPD_E2E_NATS_PASS=<operator> \
  SIPD_E2E_OBJECTS=<scratchpad>/e2e/objects SIPD_E2E_NATS_PID=$(cat <scratchpad>/e2e/pids/nats.pid) \
  go test -count=1 -tags e2e -run 'TestReviewLive' -v .
```

| Finding                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **smoke call (before)**                       | `TestE2EPhoneToPhoneCall`: 200 OK in 172 ms, 99 RTP packets each way, 0 lost, DTMF `5` delivered, hold→`recvonly`, resume→`sendrecv`, BYE 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PASS** |
| **R01** recording pause                       | `TestReviewLiveR01RecordingPause`. Real 1601→1602 softphone call; recording on the A-leg session, `direction: both`; both ends play an 8000-amplitude 440/660 Hz tone throughout, including for the whole 4.002 s pause. WAV = **10.0 s**; per-500 ms mean \|sample\|: **6433.2** for 0.0–3.0 s, **exactly 0.0** for 3.0–7.0 s, **6433.2** for 7.0–10.0 s. Not one paused frame reached the file, and the file still spans the call                                                                                                                                                                                                                                                                                                                                                                             | **PASS** |
| **R03** duplicated secure negotiation         | (a) `TestE2ESDESOverTLS` on TLS **5161**: answer is `RTP/SAVP` with `a=crypto` tag 1, wire bytes are ciphertext (80 zero crossings/frame) that decrypt to a clean 660 Hz tone (18/frame), 50 plaintext packets aimed at the SRTP port all dropped (`mediad_rtp_packets_dropped_total{reason="malformed"}` 0→50). (b) `TestReviewLiveR03DuplicateSecureNegotiation`: two SDES sessions allocated on the live mediad, every `allocate-session` and `create-offer` **replayed byte for byte** — leg 0 answer key `+AQ1eOe2RSmW…` on both, leg 1 `Ysb/Uct4GoQL…` on both, and the whole SDP body identical; the two replayed `create-offer` bodies also identical. After the duplicates the pair was bridged and SRTP under the original keys still decrypted: **100 packets each way, energy 5088, 0 undecodable** | **PASS** |
| **R02** wrong remote tag                      | `TestReviewLiveR02WrongRemoteTag`. BYE with the right Call-ID and the right **local** tag (`xCtyX41czqRqryQj`) and a deliberately corrupted remote tag → **481 Call/Transaction Does Not Exist**. The call stayed up: 49 further RTP packets reached the callee, energy 5089. The genuine BYE then answered **200 OK**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **PASS** |
| **R06** overload admission                    | `TestReviewLiveR06CommandBurst`. 400 concurrent commands on **one** resource key, at each service. mediad `send-dtmf`: **400/400 answered, 0 unanswered**, 134 refused `capacity` + 266 `unknown_session`; peak goroutines 50 against an idle 48. sipd `resolve-target`: **400/400 answered, 0 unanswered**, 129 refused `capacity` + 271 accepted; peak 53 against an idle 53. Afterwards **sipd 52 (idle 53), mediad 48 (idle 48)** — back to baseline. The refusals are the per-key pending cap (256) doing its job, not unbounded queueing                                                                                                                                                                                                                                                                  | **PASS** |
| **R16** registration clamp                    | `TestReviewLiveR16RegistrationClamp` on the internal profile (300 s clamp). Requested 3600 → granted **`expires=300`**; requested 1800 → **300**; requested 120 → **120** (under the clamp, untouched). Headline `Expires: 300` in all three                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **PASS** |
| **R17** SUBSCRIBE / REFER lockout             | `TestReviewLiveR17SubscribeAndReferCountTowardLockout`. Three wrong-password **SUBSCRIBE** (`Event: dialog`) and three wrong-password out-of-dialog **REFER**, all 403, against a threshold of 5 — then a REGISTER with the **correct** password was refused **403**. One shared budget, fed by both methods. sipd logged five `rejecting a failed digest`. The account recovered on its own after the 30 s lockout base and registers again                                                                                                                                                                                                                                                                                                                                                                    | **PASS** |
| **R04 / R23** teardown across a broker outage | `TestReviewLiveR04R23BrokerOutageTeardown`. Call up, four fresh `sip-dialogs` claims, then `kill -STOP` the broker for **5.008 s** and a BYE sent 200 ms into the outage. sipd answered the BYE **200 OK while the broker was down**. After `kill -CONT`: **exactly one** `dialog.terminated` in the `SIP` stream for that Call-ID (a stable id across retry — not one per attempt), visible at **+17 ms**; the claims were deleted at **+32.1 s**, i.e. strictly **after** the termination was durable, never before                                                                                                                                                                                                                                                                                           | **PASS** |
| **R09** 30 ms member in a conference          | `TestReviewLiveR09ConferencePacketisation`. Three sessions bridged into a real mixed room (`"mixed": true`). The 30 ms member sent 200 packets of 240 samples over 6.000 s at 440 Hz; the 20 ms member sent 300 packets at 660 Hz. Each received **300** packets (50/s, no underrun). Dominant frequency measured from the decoded µ-law: the 30 ms member heard **656 Hz** (want 660), the 20 ms member heard **436 Hz** (want 440 — a broken mixer would give **660**, a 1.5× shift), the silent third member heard the 622 Hz mixture. A recording of the 30 ms leg is **6.000 s of media time for 6.000 s of wall time, ratio 1.000**                                                                                                                                                                       | **PASS** |
| **`activeChannels` → 0**                      | engine `/healthz` reported `activeChannels: 0` before the final smoke call and again 30 s after it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **PASS** |
| **smoke call (after)**                        | `TestE2EPhoneToPhoneCall` again: 200 OK, 99 packets each way, 0 lost, DTMF, hold/resume, BYE 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **PASS** |

**11 items · 11 PASS · 0 PARTIAL · 0 FAIL.**

### One item narrowed rather than fully exercised

`create-offer`'s **SDES** branch could not be driven on this stack: `Server.offerSDES` returns an
empty crypto only when `MEDIAD_SRTP_POLICY == require`, and this deployment is not in require mode,
so create-offer answers a plain `RTP/AVP` offer. The R03 _retry_ property was still verified on that
command — both replays returned byte-identical bodies — and the key-identity half was verified in
full on `allocate-session`, which does carry SDES here. Proving the create-offer key branch live
needs a mediad restart under `MEDIAD_SRTP_POLICY=require`; it is covered by
`internal/control/negotiation_test.go` in the unit suite.

## 3 · State after the round

- All eight services running and green: api, engine, sipd, mediad, web, NATS, Postgres, SMTP.
- `/healthz` 200 on sipd `:9290`, mediad `:9291`, engine `:9300`, api `/api/auth/ok`;
  `/metrics` 200 on `:9200 :9201 :9290 :9291`. Engine `activeChannels: 0`.
- **Broker permission violations 1009 → 1009 across the entire round — zero new.**
- Every WARN+ logged during the round is attributable to a probe and expected:
  sipd 129 × `refusing a command at admission` (R06), 5 × `rejecting a failed digest` (R17),
  6 × `SIP teardown did not receive a final response` (the probe UAs and the outage teardown);
  mediad 134 × `refusing a command at admission` (R06) and 2 × idle-session reap plus 2 ×
  `a session stopped receiving RTP` for the sessions the R03/R09 probes allocated directly and left
  to the reaper. No new WARN class.
- Data: **nothing created, changed or deleted** in any tenant. The probes used the existing sip-e2e
  extensions 1601/1602 in org `01a08708-4cd4-76b9-b56d-d26ebf326b0a`. Extension 1602 was
  deliberately locked out for 30 s by R17 and was confirmed registering again before the round
  ended. Probe recordings are under
  `<scratchpad>/e2e/objects/01a08708-…/` as `review-r01-*.wav` and `review-r09-*.wav`, and are
  deletable.
- Files added, both **test-only**: `apps/sipd/e2e_review_live_test.go` (new) and one exported helper
  `SendTonePaced` appended to `apps/sipd/internal/testutil/sipua/rtp.go`. `gofmt -l .` clean,
  `go vet ./...` clean under no tag and under `e2e`, `integration` and `load`.

## 4 · Note for whoever runs this next

- The derived SIP password for these extensions is
  `hmac-sha256(PROVISION_SIP_SECRET_KEY, "<orgId>:<sipSecretRef>")`, base64url, first 24 characters
  (`apps/api/src/provisioning/render/provision-secret.ts`). A one-line deriver is in
  `<scratchpad>/live/derive.mjs`; `<scratchpad>/load/derive.mjs`, which this file's runbook still
  points at, does not exist.
- The per-binding registration grant is the **Contact's `expires` parameter**, not the headline
  `Expires` header — the latter reports the registrar's negotiated default (300) even when a shorter
  binding was granted. An assertion on the header alone reads as a clamp failure and is not one.
- `kill -STOP` on the broker for five seconds stalls every service's JetStream traffic, including
  the api's. Anything another agent measured between 03:31:15 and 03:31:20 UTC should be re-run.
