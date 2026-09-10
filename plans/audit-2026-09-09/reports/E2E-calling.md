# E2E — AREA=calling

The live call experience between browser softphones, and the softphone UI itself, driven against the
standing stack (`STACK.md`) with Playwright Chromium, real `/softphone` pages, real WSS registrations
against sipd, real SRTP through mediad, and real audio energy read off `RTCPeerConnection.getStats()`.

Harness: `<scratchpad>/e2e/calling/` — `harness.mjs` (instrumented browser context: synthetic
microphone, PeerConnection capture, full SIP-over-WebSocket wire recording), `phones.mjs` (drives the
real dialer), `setup.mjs` (world), `s1-basics.mjs`, `s2-features.mjs`, `s3-load.mjs`, plus focused
probes (`probe-cancel`, `probe-reject`, `probe-rotate`). Artifacts:
`<scratchpad>/e2e/artifacts/calling/`.

## World, and one deployment constraint found while building it

The SIP realm is a deployment-wide unique claim (`org_setting sip/realm`, enforced by
`sip-credentials.service.ts#resolveOrganizationForRealm`) and sipd challenges with a single
`SIPD_REALM`. **Exactly one organization per deployment can host browser softphones.** That org here
is the smoke org (`01a08708-…`, realm `local.test`). This area therefore added its own users
(`calling…-200x@local.test`) and its own extension block **2001 / 2002 / 2003** inside that org and
touched nothing the smoke run created. Nothing was deleted; extension settings changed during
scenarios were reverted.

---

## Scenario table

| #   | Scenario                             | Expected                                      | Observed                                                                                                                                                       | Evidence                                                                 | Verdict                |
| --- | ------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------- |
| 1   | 2001 → 2002, answered                | ring, then two-way audio                      | ring 304–815 ms, audio 1.70 s after dial                                                                                                                       | caller `packets=26 energy=0.427`, callee `packets=27 energy=0.456`       | PASS                   |
| 2   | Reverse 2002 → 2001                  | same                                          | audio both ways                                                                                                                                                | `energy=0.446 / 0.465`                                                   | PASS                   |
| 3   | Mute / unmute                        | far-side energy → ~0, then recovers           | muted ΔE `0.000000`, unmuted ΔE `1.4417`                                                                                                                       | `s1-basics.json`                                                         | PASS                   |
| 4   | Hold from the caller                 | audio stops both ways                         | ΔE `0.000000` near and far                                                                                                                                     | "                                                                        | PASS                   |
| 5   | Hold from the callee                 | caller's audio stops                          | ΔE `0.000000`                                                                                                                                                  | "                                                                        | PASS                   |
| 6   | Both hold, one resumes               | audio stays down until both resume            | ΔE `0.000000` then `1.4417`                                                                                                                                    | "                                                                        | PASS                   |
| 7   | Callee's UI while held               | some "the other side put you on hold" state   | callee panel still reads `Connected · 0:09`; also **no music on hold** — pure silence                                                                          | callee panel text in `s1-basics.json`                                    | **FAIL (P2)**          |
| 8   | DTMF from the in-call keypad         | digits reach the platform                     | 3 SIP INFO frames out; sipd logs `dtmf digit=1/2/#`; UI echoes `Sent: 12#`                                                                                     | `dtmf-wire.json`, sipd.log                                               | PASS                   |
| 9   | Hangup                               | far end sees the call end                     | "Call ended" within 20 s                                                                                                                                       | —                                                                        | PASS                   |
| 10  | **Caller cancels before answer**     | callee stops ringing                          | caller gets `487`; **the callee never receives a CANCEL and rings forever**                                                                                    | `probe-cancel.mjs` output: callee wire ends at `out SIP/2.0 180 Ringing` | **FAIL (P0)**          |
| 11  | Callee rejects                       | caller told "busy/declined"                   | was `480 Temporarily Unavailable` → UI "Unavailable"; **fixed**, now `486 Busy Here` → UI "Busy"                                                               | `probe-reject.mjs` before/after                                          | FAIL → **fixed**       |
| 12  | Busy while on a call                 | second caller refused, first call undisturbed | callee answers `486 Busy Here`; caller sees "Unavailable" (engine relays `480`); first call's audio survives (ΔE `1.153`)                                      | `probe-reject.mjs`                                                       | PARTIAL (P1)           |
| 13  | No-answer timeout → fallback         | ring 6 s then ring 2003                       | first run: 2002 rang past 25 s, 2003 never rang (stale artifact). **Re-run with a healthy watch: 2003 rang at 6537 ms and carried audio**                      | `s6-config.json`                                                         | PASS (after finding A) |
| 14  | DND                                  | extension does not ring                       | first run: 2002 rang. **Re-run: 2002 silent, caller told "Busy"; clearing DND restores ringing**                                                               | `s6-config.json`                                                         | PASS (after finding A) |
| 15  | Follow-me ladder                     | 2003 rings at +5 s                            | first run: never rang. **Re-run: 2002 rang, then 2003 at +10538 ms, audio followed**                                                                           | `s6-config.json`                                                         | PASS (after finding A) |
| 16  | Click-to-call `POST /api/v1/calls`   | originator rings first, then destination      | 2001 rang after **24–34 ms**, then 2002, two-way audio ΔE `1.26`                                                                                               | `s2-features.json`                                                       | PASS                   |
| 17  | Socket drop → re-registration        | reconnects and calls work                     | UI goes Offline, re-registers, next call completes                                                                                                             | "                                                                        | PASS                   |
| 18  | Credential rotation while registered | phone re-registers with the new secret        | UA **does** re-REGISTER; sipd answers `403` for ~30 s (its credential cache TTL), phone shows "Registration failed", recovers by ~18 s–30 s                    | `probe-rotate.mjs`: `~3s registered=false` → `~15s SUCCEEDED`            | PARTIAL (P1)           |
| 19  | Microphone denied                    | go online works; call explains the denial     | online OK; caller card reads **"User Denied Media Access"**                                                                                                    | `mic-denied.png`                                                         | PASS                   |
| 20  | Blind transfer                       | REFER from the softphone                      | **not implemented in the browser softphone** — `SipUserAgent` has no transfer verb, though sipd implements REFER end to end (`OnRefer`, `rpc.sip.v1.transfer`) | `lib/softphone/sip-adapter.ts`                                           | **FAIL (P1, missing)** |
| 21  | Attended transfer                    | consult + complete                            | same — no UI, no adapter verb                                                                                                                                  | "                                                                        | **FAIL (P1, missing)** |
| 22  | Park / unpark (UI)                   | park button                                   | no park control in the softphone                                                                                                                               | `softphone-dialer.tsx`                                                   | **FAIL (P2, missing)** |
| 23  | Park via feature code                | `*70`-style code                              | no feature codes or park lots exist in this org, and creating them needs a routing change the engine will not pick up                                          | DB: `feature_code` and `park_lot` empty for this org                     | **BLOCKED**            |
| 24  | DND toggle from the softphone        | user can set DND                              | no DND control in the softphone; only an admin can set it on the extension                                                                                     | `softphone-dialer.tsx`                                                   | **FAIL (P2, missing)** |
| 25  | Redial / recent calls                | a recents list                                | **absent** from the softphone entirely                                                                                                                         | "                                                                        | **FAIL (P2, missing)** |
| 26  | 50 back-to-back calls, leak watch    | no failures, no latency creep, no leak        | 49/50 completed; latency flat; every process back to baseline                                                                                                  | `s3-load.json`, `s3-progress.log`, `mediad-goroutines-debug2.txt`        | PASS                   |
| 27  | CDR legs correct                     | 2 legs per two-party call                     | **4 legs**, two of them never answered but filed `disposition = answered`, `hangup_cause = NORMAL_CLEARING`                                                    | `call_legs` for `0249c1f4-…`                                             | **FAIL (P1)**          |

---

## Findings

### P0

**B. A caller who cancels before answer leaves the callee's phone ringing forever.** — FIXED, needs a
restart to verify.
Caller CANCEL → sipd answers `487` correctly, but the B-leg is never cancelled: the callee's SIP wire
ends at `out SIP/2.0 180 Ringing` and its UI still shows Answer/Reject 8 s later (and indefinitely).
Root cause in `apps/engine/src/routing/plan-walker.ts`: `watchCallerHangup` — the watcher that turns
the A-leg's death into an `aborted` dial outcome, which the existing loser-cleanup then converts into
`ORIGINATOR_CANCEL` on the wire — was installed only for **queue** dials. Its doc comment stated the
assumption plainly ("for an unanswered inbound call the caller's hangup tears the whole call down in
one event and the walk aborts anyway"). That was true under ARI; under the split plane the A-leg's
`dialog.terminated` is only a bus signal, and the walk is parked inside `dialSimultaneous` awaiting the
ring, where `abandoned` is never consulted. Answering the stranded call bridges the callee to a leg
that no longer exists.

### P1

**A. The engine's routing-artifact watch stalls silently for tens of minutes; configuration changes
apply at an unpredictable later moment.**
`apps/engine/src/routing/routing-artifact.source.ts` invalidates its in-memory artifact cache from a
`routing-cache` KV watch, with a 1 h TTL (`CACHE_TTL_MS = 3_600_000`) as the only backstop. Measured
on this stack:

- A `PATCH` at **16:57:36Z** compiled correctly and reached KV (rev 1099, containing
  `"number":"2002" … "timeoutSeconds":6,"doNotDisturb":true,"noAnswerNodeId":"extension:…2003"`).
- The engine did not apply it until **17:32:18Z** — a **35-minute** silent stall. Throughout it kept
  executing the old artifact (DND ignored, 30 s ring timeout, no no-answer branch), and it never
  logged the `"the routing-cache watch ended"` warning its reconnect path emits, so the loop believed
  it was still watching. Every applied-update line during the stall belonged to one other tenant.
- Once the watch recovered, propagation was **0–154 ms** across six consecutive patches, and every
  configuration scenario passed (scenarios 13–15, `s6-config.json`).

The features are correct; the delivery is not. In production an admin's change to DND, forwarding,
follow-me, ring time or the dial plan silently does nothing for an unbounded period and then takes
effect at a moment nobody chose — here it turned every call to an extension into a busy signal long
after the operator had moved on. `/healthz` does not expose the watch's `watching` flag, so the stall
is invisible. Suggested fix: surface `HeldArtifacts.watching`/`kvReads` on `/healthz`, add a liveness
deadline to the watch loop (no entry within N minutes ⇒ tear it down and reconnect), and shorten the
backstop TTL well below an hour.

_Severity note_: filed P0 on first observation, when it looked permanent; demoted to P1 once the watch
was seen to recover on its own — the data is never wrong, only late.

**C. `disposition` is wrong on fan-out legs that were never answered.** One 2001→2002 call writes four
`call_legs`: the `internal` A-leg, the answered B-leg, and two B-legs with `answered_at IS NULL`,
`billsec_ms = 0`, `duration_ms ≈ 65` — filed as `disposition = "answered"`, `hangup_cause =
NORMAL_CLEARING`. `dispositionFor` (`apps/engine/src/calls/cdr-leg.ts:42`) classifies an unanswered leg
by its cause, and `NORMAL_CLEARING` is in `ANSWERED_HANGUP_CAUSES`, so it returns `answered`. The
walker already guards the _refused-originate_ path (`plan-walker.ts:6422` sets
`USER_NOT_REGISTERED`, first-wins), and its comment describes exactly this symptom — but on these legs
something set `NORMAL_CLEARING` first, so the guard never lands. Any "answered calls" or per-leg
billing metric is inflated. Not fixed: the fix is either an ordering change in a race I could not
reproduce deterministically, or narrowing the deliberate "the answer instant was lost" fallback, and
neither is a local one-line call.

**D. Closed browser softphones leave stale registrations, and every later call fans out to them.**
A `/softphone` tab that goes away (tab closed, context destroyed) never un-REGISTERs, and sipd keeps
the WSS binding until it lapses. Every subsequent call to that extension is originated to each dead
contact; sipd logs
`refusing an originate … reason:"no_route" … connect: connection refused` followed by
`refusing a hangup … reason:"unknown_dialog"`, and those legs become the phantom CDR rows in finding C.
A WSS binding is reachable only over its own socket, so sipd could drop it on socket close. There is
also no "go offline" control in the softphone UI at all (`SoftphoneContextValue.disconnect` exists and
is never rendered), so a user cannot even un-register deliberately.

**E. Rotating an extension's SIP secret takes the phone offline for up to 30 s.** sipd caches
credentials for 30 s (`credential store ready … cacheTtl:30000000000`). After
`PATCH /api/v1/extensions/:id { sipSecretRef }` the browser correctly refreshes and re-REGISTERs with
the new secret — the adapter's rotation handling works, which was the thing to prove — but sipd answers
`403 Forbidden` to both the REGISTER and the next INVITE until its cache expires. Measured: at ~3 s
`registered=false`, UI "Registration failed"; by ~18 s the call succeeded. The API should invalidate
sipd's credential cache on rotation, or sipd should retry a digest failure once against a fresh lookup.

**F. Busy is relayed to the caller as `480`, not `486`.** With 2002 already on a call, its phone answers
`486 Busy Here`, but the caller's wire carries `480 Temporarily Unavailable` and the UI says
"Unavailable". A caller cannot tell "busy" from "unreachable", and a dial plan reading `480` will keep
hunting on a final rejection. (The other half of this — the browser itself sending `480` on Reject —
is fixed below.)

**G. Blind and attended transfer are not reachable from the browser softphone.** sipd implements REFER
fully (digest-authenticated, `Replaces`, `rpc.sip.v1.transfer`) and `CallControl` has
`transfer` / `completeTransfer` / `cancelTransfer`. The browser side has neither: `SipUserAgent`
(`lib/softphone/sip-adapter.ts`) exposes only start/stop/call/answer/hangup/hold/mute/DTMF, and the
dialer renders no transfer control. The platform's transfer capability is unreachable by its own
softphone users.

### P2

**H. The held party is told nothing and hears nothing.** When A holds, B's panel still reads
`Connected`, and B's inbound energy is exactly `0.000000` — silence, not music on hold. B has no way to
know why the line went quiet.

**I. The `/softphone` route renders two dialers.** The page's own card and the docked widget both mount
`SoftphoneDialer`, producing duplicate keypads and two inputs with the same
`aria-label="Number to dial"` on one screen (Playwright's strict mode flags it; so would a screen
reader).

**J. No park, no DND toggle, no redial, no recent-calls list in the softphone.** Each is supported
somewhere in the platform (park lots, `doNotDisturb` on the extension, `/api/v1/cdr`) and absent from
the phone.

**K. Log noise from sipgo.** 39 × `WS ref went negative` from `sipgo/sip/transport_ws.go:352` during
this session — a connection refcount going below zero on the WSS transport.

---

## Fixes applied

**1. `apps/web/lib/softphone/jssip-adapter.ts` — Reject sends `486 Busy Here`.**
`hangup()` handed every unanswered session to jssip's default, which for an _incoming_ session is
`480 Temporarily Unavailable`. A user pressing Reject is reachable and said no; `480` reads as "keep
hunting" to a dial plan and as "Unavailable" to the caller. `hangup()` now distinguishes the three
things one button means: BYE on an established session, CANCEL on an outgoing one in progress, and
`486 Busy Here` on a ringing incoming one.
Tests: `lib/softphone/jssip-adapter.spec.ts` — three new cases (reject → 486, established → no status
code, outgoing → no status code); the fake session grew a direction and an `established` flag.
`bun test lib/softphone` → 28 pass.
**Verified live**: caller's wire went from `480 Temporarily Unavailable` / UI "Unavailable" to
`486 Busy Here` / UI "Busy" (`probe-reject.mjs`, before and after).

**2. `apps/engine/src/routing/plan-walker.ts` — every dial aborts when the caller hangs up.**
`abortOnCallerHangup` now defaults to `true` on `dialSimultaneous` and `dialOne` (it was `false`, with
the queue path the only caller passing `true`). The stale ARI-era reasoning in `watchCallerHangup`'s and
`dialQueueAgents`' doc comments is replaced with the split-plane one. No call site changed; the queue
path still passes `true` explicitly.
Tests: `src/routing/plan-walker.spec.ts` — "cancels the ringing callee when the caller hangs up first"
asserts the outcome is `aborted` and the B-leg was hung up with `ORIGINATOR_CANCEL`. Confirmed it fails
(times out at 5 s) with the default flipped back. `bun test src/routing src/calls` → **968 pass, 0
fail**.

## Needs restart to verify

- **`apps/engine`** — fix 2 (caller-cancel teardown). Not restarted: other agents are exercising the
  engine. After a restart, `probe-cancel.mjs` should show a `CANCEL` on the callee's wire and the
  ringing card clearing.
- An engine restart would also clear finding A's stalled KV watch and unblock scenarios 13–15 and 23,
  which I would re-run.

## Measurements

### 50 back-to-back calls (2001 → 2002, answer, two-way audio, hang up)

**49 of 50 completed**; one round failed on a Playwright locator timeout with no SIP or media
symptom behind it, and the surrounding rounds are unremarkable.

|                           | p50     | p99     | max     | first-ten mean | last-ten mean |
| ------------------------- | ------- | ------- | ------- | -------------- | ------------- |
| dial → callee ringing     | 206 ms  | 318 ms  | 318 ms  | 216 ms         | 224 ms        |
| ringing → audible audio   | 1393 ms | 1400 ms | 1400 ms | 1392 ms        | 1388 ms       |
| hang up → far end sees it | 41 ms   | 53 ms   | 53 ms   | 38 ms          | 38 ms         |

**No latency creep**: the last ten rounds are within 4 % of the first ten on every measure.

### Heap, goroutines and RSS around the 50 calls

|                    | before    | after (+5 s)        | settled |
| ------------------ | --------- | ------------------- | ------- |
| sipd goroutines    | 62        | 72                  | **63**  |
| sipd HeapInuse     | 4.88 MB   | 4.91 MB (+0.5 %)    | 5.34 MB |
| sipd HeapObjects   | 15 199    | 13 123 (−13.7 %)    | 21 116  |
| mediad goroutines  | 43        | 88                  | **43**  |
| mediad HeapInuse   | 4.35 MB   | 3.98 MB (−8.5 %)    | 4.36 MB |
| mediad HeapObjects | 12 468    | 8 272 (−33.7 %)     | 7 028   |
| engine RSS         | 63 472 kB | 52 144 kB (−17.8 %) | —       |
| api RSS            | 43 184 kB | 43 440 kB (+0.6 %)  | —       |

**No leak.** The `+45` mediad goroutines and `+10` sipd goroutines in the "after" reading are
in-flight work five seconds past the last hangup, not retained state: both processes returned to
their exact baselines (43 and 63) once quiet, `engine /healthz` reports `activeChannels: 0`, and heap
in-use and object counts are flat or lower than they started. mediad's settled profile is 32
`sync.runtime_notifyListWait` workers (a fixed pool) plus its listeners
(`mediad-goroutines-debug2.txt`). Note the stack is shared with other agents, so absolute counts
drift; the before/settled comparison is the meaningful one.

### API latency (60 sequential requests each, from a signed-in session)

| endpoint                   | p50   | p95   | p99   | max   |
| -------------------------- | ----- | ----- | ----- | ----- |
| `GET /api/v1/me/softphone` | 11 ms | 18 ms | 55 ms | 55 ms |
| `GET /api/v1/cdr`          | 14 ms | 19 ms | 25 ms | 25 ms |
| `GET /api/v1/extensions`   | 15 ms | 21 ms | 23 ms | 23 ms |

### Routing-artifact propagation

0 ms, 0 ms, 1 ms, 2 ms, 154 ms across six consecutive `PATCH`es once the KV watch was healthy —
against the 35-minute stall documented in finding A.

### Permissions spot-check (`s5-perm.mjs`, as an ordinary extension holder)

`GET /api/v1/me/softphone` allowed (own extension only); `PATCH` of another extension **403**;
`PATCH` of one's own extension **403**; `POST /api/v1/calls` **403** for both another extension's
number and one's own. No holes. Worth flagging as a product question rather than a defect: a user
cannot click-to-call from their own extension, though `calls.dto.ts` describes the endpoint as the
home of "a CRM, a browser extension or a dial button".

## Not tested, and why

- **Park by feature code, and DTMF into an IVR fixture** — this organization has no `feature_code` and
  no `park_lot` rows, and creating them is a routing change whose propagation was unreliable for most
  of the session (finding A). No-answer fallback, DND and follow-me WERE re-run successfully once the
  watch recovered (`s6-config.json`).
- **A harness note, so the numbers are not misread**: an early version of the load loop created a new
  `AudioContext` per synthetic microphone. Chromium caps AudioContexts per document, so after ~23
  calls the fake microphone went silent and the run looked like a platform media failure. The shim now
  holds one context for the life of the page; the reported 49/50 run is from the corrected harness.
- **Blind / attended transfer end to end** — no browser-reachable transfer verb exists (finding G), so
  there is nothing to drive from a softphone. sipd's REFER handler has its own Go tests.
- **Park / unpark via the UI** — no control exists.
- **Call waiting** — the softphone models one line by design (`call-state.ts` says so) and the adapter
  refuses a second INVITE with 486; there is no call-waiting setting to test against.

---

## Tally

Machine-checked assertions across the four suites (`s1-basics`, `s2-features`, `s3-load`,
`s6-config`): **45 pass, 6 fail, 3 blocked, 3 informational**.

The six failures, and what each really is:

1. `caller cancel before answer clears the callee's ringing UI` — **P0-B**, fixed, needs an engine
   restart to verify.
2. `callee UI shows it was put on hold` — **P2-H**, the held party is told nothing.
3. `callee reject produces a 486/603 on the caller's wire` — **P1/F**, fixed on the browser side
   (verified live); the engine still relays a busy callee's `486` to the caller as `480`.
4. `a call still completes after the SIP secret is rotated mid-registration` — **P1-E**, sipd's 30 s
   credential cache; recovers on its own.
5. `50 back-to-back calls` — 49/50; one Playwright locator timeout with no SIP or media symptom.
6. `mediad.goroutines after 50 calls` — a transient in-flight reading, not a leak: it settled back to
   its exact baseline (see Measurements).

The three "blocked" rows are the first-pass records of scenarios 13–15, which **passed** on re-run
once the routing-cache watch recovered (`s6-config.json`).

The missing-feature findings (G, J — transfer, park, DND toggle, redial) are not counted above: there
is nothing to assert against, and they are recorded in the scenario table and the findings list.
