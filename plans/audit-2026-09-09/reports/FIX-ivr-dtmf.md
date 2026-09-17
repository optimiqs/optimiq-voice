# FIX — AREA = IVR DTMF (browser → sipd/mediad → engine gather)

Run: 2026-09-09 18:30–19:15 UTC against the standing stack (`STACK.md`). Nothing was restarted.
`apps/web` is `next dev`, so its change went live by hot reload; `apps/engine` and `apps/sipd`
changes are **not** live and are listed under "Needs restart".

## Verdict up front

**DTMF was never broken.** Every layer works, and worked before I touched anything:

| Layer                     | Evidence                                                                              | Verdict                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1. Harness press          | in-call keypad reachable, `pressed 1 in 18 ms`                                        | the press was fine; the PASS line was not (H-1, H-2, H-3) |
| 2. Browser → edge         | sipd `msg:"dtmf" digit:"1"` 1.7 s after admission, on the caller's legId              | SIP INFO arrived, and always had                          |
| 2b. Browser → media plane | after the fix: 4→submenu→1→**1103** with **zero** sipd `dtmf` lines                   | RFC 4733 now rides the RTP (W-1)                          |
| 3. sipd → engine          | `sip.evt.v1…dialog.dtmf` → `dtmf-received` (`sipd-event-mapping.ts:183`)              | fine                                                      |
| 4. Engine gather          | `originated a call` 10–17 ms after each digit, to the option's destination            | fine                                                      |
| 5. SIP phone, RFC 4733    | new `TestE2EIVRDigitFromASIPPhone`: **extension 1101 rang 216 ms after the keypress** | fine                                                      |

`E2E-routing.md` scenario 14 ("every call fell to the timeout destination") and
`FIX-tenant-prompts.md`'s "no phone rang for option 2 / 4 / direct dial / invalid 7" are **stale**:
they were measured before/at the moment the engine restarted at 18:03 UTC and while the greeting
still did not play. Re-measured today, five of six IVR branches route, and the sixth cannot route by
construction (H-3).

## Layer-by-layer evidence

### 1 — the harness (`<scratchpad>/e2e/routing/ivr.mjs`)

`press()` used `getByRole("button", { name: digit, exact: true }).last()`. That locator is actually
correct against today's dialer — the idle keypad's buttons are named `"2 ABC"` (digit + letters) and
only the **in-call** DTMF keypad is named exactly `"2"` — so the `Timeout 10000ms exceeded` the
earlier agents saw was not a stale selector. It was the call **not being up**: the in-call panel
only renders for `call.status === "active"`, and every one of those failures is paired with
`greeting="FAIL Timed out: IVR greeting audio"` in the same probe. The press failed because the call
had failed, not the other way round.

Fixed anyway, so the two failures cannot be confused again:

- **H-1 — the press now waits for the ACTIVE call** (`Hang up` is the marker) and takes the keypad
  from inside that panel, so a press that fails now fails because the digit button is missing, not
  because the page had not got there yet.
- **H-2 — the inverted PASS.** `const ok = probe.expect === "any" ? typeof rang === "string" : …`
  reported a PASS for the ring-group branch on **every** timeout, because `rang` is the string
  `"FAIL Timed out: …"` on failure. Now: `rangOk = typeof rang === "string" && !rang.startsWith("FAIL")`,
  and `"any"` is checked against an explicit member list rather than against the type of the value.
- **H-3 — the direct-dial probe could never pass.** IVR 4020 has `maxDigits: 1`, so the first `1` of
  `"1104"` matches option 1 and the call routes to 1101 before the second digit exists. Proven:
  sipd logged `dtmf 1` at 13:38:46.103 and `originated a call` at 13:38:46.112, then took `1`, `0`,
  `4` with nothing left collecting. The probe now reads the menu from the API and SKIPs with the
  reason printed, instead of reporting a fixture limit as a product failure. (Raising `maxDigits` on
  the shared org's menu would change another agent's fixture; I did not.)
- **H-4 — `hangup()` had no timeout** (`lib.mjs`). `settle()` hangs up five tabs, four of which have
  no call, at Playwright's default 30 s each: 2.5 minutes of dead wait per probe, ~15 minutes for
  the sweep, and one run I had to kill. Now 3 s.

**Sweep after the fixes** (`node ivr.mjs ivr`):

```
IVR PASS option 1 -> extension 1101: rang=1101 in 2287 ms
IVR PASS option 2 -> ring group:     rang=1101 in 2067 ms
IVR PASS option 4 -> submenu, then 1 -> 1103: rang=1103 in 3294 ms
IVR SKIP direct dial 1104: menu 4020 has maxDigits=1 (see H-3)
IVR PASS invalid option 7 -> 1104:   rang=1104 in 20044 ms
IVR PASS no digits -> timeout 1104:  rang=1104 in 18253 ms
errors: {"caller":[]}
```

### 2 — browser → sipd/mediad: the transport was SIP INFO, and that is a real gap (W-1, FIXED)

`jssip-adapter.ts` called `session.sendDTMF(tone)`. JsSIP 3.13.8's default is
`DTMF_TRANSPORT.INFO` (`RTCSession.js:694`), so every browser keypress left as a SIP INFO body.
`sipd` parses it (`invite/handler.go:1088`), publishes `dialog.dtmf`, and the engine maps it to the
same `dtmf-received` member `mediad` produces — which is why the IVR worked.

What INFO cannot do is reach the **other party**. A digit that only exists in signalling is invisible
to a bridged far end, so a user calling an external IVR through a trunk from the browser could not
drive it, and nothing said why. RFC 4733 rides the RTP `mediad` is already relaying: `mediad`
detects it for the engine (`rtp/dtmfdetect.go`) _and_ forwards it to the peer leg with the payload
type remapped (`rtp/session.go:588`), and the WebRTC transport deliberately preserves
telephone-event payloads rather than rewriting them as audio (`webrtc/transport.go:301`).

The negotiation was never the problem: `mediad`'s WebRTC answer offers telephone-event 101
(`control/webrtc.go:46`) and the browser's own 126 is what settles —
`session codec settled … telephoneEventPayloadType:126` on every browser leg in `mediad.log`.

**Fixed** — `apps/web/lib/softphone/jssip-adapter.ts`: `sendDtmf` picks `RFC2833` when the leg's
audio sender reports `canInsertDTMF`, and keeps `INFO` as the fallback for a leg that negotiated no
telephone-event type (where `sendDTMF` would enqueue the digit into a sender that can never emit it
— a keypress lost with only a JsSIP warning). Spec: `jssip-adapter.spec.ts` → "dtmf transport",
3 cases (negotiated, not negotiated, no peer connection yet).

**Verified live, after the change:** `dtmfprobe.mjs 41` → `pressed 4`, `pressed 1`, `rang: 1103`,
with **0** `msg:"dtmf"` lines in `sipd.log` for the whole window — the digits no longer travel in
signalling at all, and the menu still routes. A second full sweep re-passed options 2, 4→1, invalid
and timeout on the new transport.

### 3 — the engine's gather

No defect found. `onDtmf` (`channel-orchestrator.service.ts:2582`) emits on the leg signal bus
before anything else, and the gather takes it: every digit in the logs is followed 7–17 ms later by
`originated a call` towards the option's destination. `invalid` and `timeout` reach 1104 through
their own branches at 20 s and 18 s, matching `maxFailures: 2` / `digitTimeoutMs: 6000`.

### 4 — the same IVR from a SIP handset (new test)

`apps/sipd/e2e_ivr_test.go` — `TestE2EIVRDigitFromASIPPhone`, behind `//go:build e2e` + `SIPD_E2E=1`
like every other scenario in that file set. It registers a caller and the option's destination,
INVITEs the menu, sends one RFC 4733 event on the RTP, and asserts the destination gets an INVITE —
the route, not the digit, because the route is the only thing that proves the engine acted.

```sh
cd apps/sipd
SIPD_E2E=1 SIPD_E2E_IVR_CALLER=1102 SIPD_E2E_PASS_1102=… SIPD_E2E_PASS_1101=… \
  SIPD_E2E_IVR_MENU=4020 SIPD_E2E_IVR_DIGIT=1 SIPD_E2E_IVR_TARGET=1101 \
  go test -tags e2e -run TestE2EIVRDigitFromASIPPhone -v .
```

```
the menu answered after 11ms
sent RFC 4733 "1"; caller RTP so far: {Packets:34 ByPayloadType:map[0:34] Energy:7643 Lost:0}
extension 1101 rang 216ms after the keypress
--- PASS
```

So the media-plane path is proven independently of the browser. (Note: `SIPD_E2E_PASS_1601` in
`artifacts/sip/state.json` is stale — sipd answers 403 with it. 1101–1104's current SIP passwords
come from `GET /api/v1/me/softphone` with each phone's cookie.)

## Additional finding, NOT DTMF (E-1, diagnostic fixed only)

Twice I caught a walk that **originated the right destination and cancelled it ~100–220 ms later**:

- 13:03:37.286 digit `1` → 13:03:37.303 `originated a call` → 13:03:37.521 `hangup cause:487
method:"cancel" from:"early"`, engine: `the routing walk finished status:"aborted"
destinationType:"extension" notes:[]`.
- 13:57:02.98 three forks of one AOR → 13:57:03.07 all three cancelled 487, same shape, and that
  call's caller never received a single audio packet.

`aborted` with an **empty** `notes` narrows to exactly one path in `plan-walker.ts`:
`watchCallerHangup` (`:6459`) — a `leg-ended` bus signal for the **A-leg** while the A-leg is up.
Every other abort a dial can produce carries a note. Neither `sipd` nor `mediad` logged a caller BYE
or session end before the cancel, so the `leg-ended` the engine acted on did not come from the wire
at that moment. I could not pin it further without engine logging, and I could not add logging and
restart.

**What I did fix:** that path now writes a note
(`the caller's leg ended while the dial was running; the dial was abandoned`), so the next
occurrence is self-describing instead of a three-service log correlation. Spec: `plan-walker.spec.ts`
→ "cancels the ringing callee when the caller hangs up first" now asserts the note.

This is a **call-setup** defect, not a DTMF one — the 13:57 instance had no digit in it at all — and
it is the most likely thing the original scenario-14 report actually measured. It deserves its own
investigation with an engine restart in hand.

## Files changed

| File                                                    | Change                                                                                                    | Test                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `apps/web/lib/softphone/jssip-adapter.ts`               | `sendDtmf` sends RFC 4733 when the leg negotiated telephone-event; INFO fallback + `canInsertDtmf` helper | `jssip-adapter.spec.ts` "dtmf transport" (+3) |
| `apps/web/lib/softphone/jssip-adapter.spec.ts`          | fake session records `sendDTMF` calls; three transport cases                                              | —                                             |
| `apps/engine/src/routing/plan-walker.ts`                | the caller-hangup abort leaves a note                                                                     | `plan-walker.spec.ts` (+1 assertion)          |
| `apps/sipd/e2e_ivr_test.go`                             | **new** — IVR driven by RFC 4733 from a SIP handset                                                       | itself                                        |
| `<scratchpad>/e2e/routing/ivr.mjs`                      | H-1 press waits for the active call; H-2 PASS logic; H-3 direct-dial skip with its reason                 | —                                             |
| `<scratchpad>/e2e/routing/lib.mjs`                      | H-4 `hangup()` takes a timeout (default 3 s)                                                              | —                                             |
| `<scratchpad>/e2e/routing/dtmfprobe.mjs`, `observe.mjs` | **new** — single-probe DOM/route diagnostic; read-only NATS event tap                                     | —                                             |

Nothing in `apps/mediad` needed changing: its WebRTC telephone-event handling is correct and is now
the plane the browser actually uses.

## Verification

| Check                                                                | Result                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm --filter @optimiq-voice/web run typecheck`                     | pass                                                                                       |
| `pnpm --filter @optimiq-voice/web run test`                          | **830 pass, 0 fail**, 2696 expect(), 39 files                                              |
| `pnpm --filter @optimiq-voice/engine run typecheck`                  | pass                                                                                       |
| `pnpm --filter @optimiq-voice/engine run test`                       | **1628 pass, 6 skip, 0 fail**, 3651 expect(), 72 files                                     |
| `pnpm exec oxlint apps/engine/src/routing apps/web/lib/softphone`    | exit 0                                                                                     |
| `pnpm exec oxfmt` (same dirs)                                        | clean                                                                                      |
| `cd apps/sipd && go vet -tags e2e ./... && go build -tags e2e ./...` | pass; `gofmt -l` clean                                                                     |
| live                                                                 | `ivr.mjs ivr` 4 PASS / 1 SKIP / 1 stack-flake; `dtmfprobe.mjs 1` and `41` pass on RFC 4733 |

`go test -race ./...` for sipd was **not** run: the only Go change is a new file behind the `e2e`
build tag, which that suite does not compile, and the file was exercised against the live stack
instead.

## Needs restart to verify

1. **engine** — the caller-hangup note (`plan-walker.ts`). Diagnostic only; nothing depends on it.
2. **web** — already live via `next dev`, and verified on the wire (see W-1).
3. `apps/sipd/e2e_ivr_test.go` needs no restart; it drives the running stack.

## Notes for the reviewer

- One probe in each long sweep failed with **no greeting audio at all** while the stack was being
  restarted underneath it (`nats disconnected` 13:52:34, sipd re-armed 13:53:29, `cause:702
deferred` hangups). Those are the resilience agent's window, not regressions; re-running the same
  probe alone passed every time.
- `sipd` now removes a WS binding when the socket closes (`removed a registration whose connection
closed` × 5 at 14:00:04) — `E2E-routing.md` P1-1 has been fixed by another agent. Stale bindings
  still linger for the life of the socket, which is why one option-1 dial forked to three contacts.
- My `observe.mjs` briefly subscribed to `calls.evt.v1.>` on the `engine` credential and was refused;
  that is one `Permissions Violation` line in the broker log at ~18:29 UTC, mine, and correct
  behaviour on NATS's part.
