# E2E — AREA = routing2

Run: 2026-09-09 19:55–21:25 UTC against the standing stack (`STACK.md`). Harness, fixtures and every
script under `<scratchpad>/e2e/routing2/`. Nothing was restarted by me.

## Environment

**I created my own organization**, which `E2E-routing.md` could not: since `FIX-tenant-realm` the SIP
realm is a per-tenant claim, so a second org's softphones register on the same sipd. Everything below
is inside it and nothing of another agent's was deleted.

- org `01a087c3-8c47-7605-9aee-fad39690fb96`, slug/run `rt2mtuiyokf`, realm **`rt2mtuiyokf.local.test`**
- owner `rt2mtuiyokf-owner@local.test` / `rt2mtuiyokf!Aa1zZ9`; extensions **1201–1205** (same password
  pattern, `rt2mtuiyokf-12xx@local.test`)
- mailboxes 1201–1205 (each with a PIN and a spoken `name` recording; 1202 also has a custom
  `unavailable` greeting — a 4.00 s / 520 Hz WAV, so "200 frames" in `mediad.log` is exact-duration proof)
- time condition "RT2 Business Hours" (+ a holiday `dateRange` rule, override code `*64`), call flow
  "RT2 Night Mode" on **4100** (toggle code `*65`), park lot 4201–4205 (20 s timeout → 1201), paging
  group **4300**, conference **4400** (PIN 4726 / moderator 9142), shared line **4500**, dial-by-name
  directory **4600**, IVR **4700** (`maxDigits 4`, `interDigitTimeoutMs 2500`, `directDialEnabled`),
  12 feature codes, a fake-carrier trunk + a `127.0.0.1/32` trunk ACL, DID **+15005550201**, and
  outbound routes "RT2 National" (`national`) / "RT2 International" (`international`).
- **Tenant B** (`01a08736-051c-76bd-8a88-5613d55fee69`, realm `tenbmtudfvz1.local.test`) gained one
  DID, **+15005550301**, pointed at the extension its owner already holds (1001). That is the only
  write outside my org, and it is additive. The brief named the _smoke_ org as the second tenant; I
  used my own instead so that no agent's org was written to for a leakage test.

Scenario 4's shared-line and scenario 9's second park orientation are the only places where a probe
did not produce a clean verdict; both are called out below.

## Scenario table

| #   | Scenario                                                                                          | Expected                                     | Observed                                                                                                                                                                              | Evidence                                  | Verdict                        |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------ |
| 1a  | Call flow 4100, day mode                                                                          | rings 1201                                   | rang 1201 in **438 ms**                                                                                                                                                               | `s1-timeflow.mjs`                         | PASS                           |
| 1b  | `POST /call-flows/:id/toggle {night}`                                                             | next call rings 1202                         | toggle acked in **51 ms**; next call rang 1202                                                                                                                                        | `s1-timeflow.mjs`                         | PASS                           |
| 1c  | **Dial the flow's toggle code `*65`**                                                             | mode flips                                   | mode `day` before and after; engine: `no outbound route matched *65`                                                                                                                  | engine.log 20:17:54                       | **FAIL (P1-1)**                |
| 1d  | Time condition, inside hours                                                                      | match branch (1201)                          | rang 1201                                                                                                                                                                             | `s1-timeflow.mjs`                         | PASS                           |
| 1e  | **Holiday**: enable a `dateRange` rule for today whose window excludes now, disable the open rule | no-match branch (1202)                       | writes acked in **61 ms**; the next call rang **1202**, 232 ms after dialling                                                                                                         | `s1-timeflow.mjs`                         | PASS                           |
| 1f  | `override: forced-match` over REST                                                                | match branch despite no matching rule        | rang 1201                                                                                                                                                                             | `s1-timeflow.mjs`                         | PASS                           |
| 1g  | **Dial the override code `*64`**                                                                  | override advances                            | `auto` before and after                                                                                                                                                               | `s1-timeflow.mjs`                         | **FAIL (P1-1)**                |
| 2a  | `*78` DND on / off                                                                                | flag toggles                                 | `doNotDisturb` true, then false                                                                                                                                                       | `s2-features.mjs`                         | PASS                           |
| 2b  | Call to a DND extension                                                                           | never rings the phone; takes the busy branch | phone never rang; caller was routed to the busy branch                                                                                                                                | `s2-features.mjs`                         | PASS                           |
| 2c  | `*72<ext>` / bare `*72`                                                                           | set, then clear                              | `forwardAllEnabled true → 1203`, then false                                                                                                                                           | `s2-features.mjs`                         | PASS                           |
| 2d  | Call to a forwarded extension                                                                     | rings 1203                                   | rang 1203                                                                                                                                                                             | `s2-features.mjs`                         | PASS                           |
| 2e  | `*74<ext>` forward-busy                                                                           | set                                          | `forwardBusyEnabled true → 1203`                                                                                                                                                      | `s2-features.mjs`                         | PASS                           |
| 2f  | `*76<ext>` + an unanswered call                                                                   | forwards to 1203                             | set, and the unanswered call rang 1203                                                                                                                                                | `s2-features.mjs`                         | PASS                           |
| 2g  | `*98<mailbox>` direct voicemail                                                                   | reaches the box                              | call active; message filed (`durationMs 20840`)                                                                                                                                       | `s2b-vm.mjs`, engine.log 20:34:06         | PASS                           |
| 2h  | `*97` own mailbox                                                                                 | PIN prompt plays                             | active, 31 packets / energy 0.070                                                                                                                                                     | `s2b-vm.mjs`                              | PASS                           |
| 2i  | `*43` echo test                                                                                   | audio returns                                | refused, by name: `split-plane cannot echo … Set ENGINE_MEDIA_DRIVER=ari`                                                                                                             | engine.log 20:32:2x                       | **CAPABILITY GAP (P2-5)**      |
| 3a  | IVR 4700 option `1` on a `maxDigits 4` menu                                                       | routes on the inter-digit timeout            | rang 1201                                                                                                                                                                             | `s3-ivrdir.mjs`                           | PASS                           |
| 3b  | IVR option `2`                                                                                    | routes                                       | rang 1202                                                                                                                                                                             | `s3-ivrdir.mjs`                           | PASS                           |
| 3c  | **IVR direct dial `1203`** (`directDialEnabled`)                                                  | rings 1203                                   | rang **1205** (the invalid branch); engine: `has direct dial enabled, which needs an internal resolve the walker cannot make yet; 1203 was treated as invalid`                        | engine.log 20:40:42                       | **FAIL (P1-2)**                |
| 3d  | Dial-by-name 4600, `22537` (BAKER)                                                                | reaches 1202                                 | rang 1202 in 36.4 s                                                                                                                                                                   | `s3c-dir.mjs`                             | PASS                           |
| 3e  | Dial-by-name 4600, `34966` (DIXON)                                                                | reaches 1204                                 | rang 1204 in 36.0 s                                                                                                                                                                   | `s3c-dir.mjs`                             | PASS                           |
| 4a  | Paging 4300 to two phones, auto-answer                                                            | both auto-answer and hear the page           | **before the fix**: both RINGING, 0 packets. **after**: both `active`, **384 packets / energy 7.24** each                                                                             | `s4-paging.mjs`, `s4c-page.mjs`           | **FAIL → FIXED → PASS (P1-5)** |
| 4b  | `*80<ext>` intercom                                                                               | auto-answers 1204                            | **after the fix**: active, 392 packets / energy 7.35                                                                                                                                  | `s4c-page.mjs`                            | **FAIL → FIXED → PASS**        |
| 4c  | A plain call after the fix                                                                        | still rings                                  | ringing, not answered                                                                                                                                                                 | `s4c-page.mjs`                            | PASS (no regression)           |
| 4d  | `*81` paging feature code (group pinned in `params`)                                              | pages the pinned group                       | engine: `no outbound route matched *81`                                                                                                                                               | engine.log 20:56:1x                       | **FAIL (P1-6)**                |
| 4e  | Shared line 4500: seize / hold / retrieve                                                         | rings both appearances                       | nothing rang; engine: `node kind "shared-line" is not implemented yet; announced and hung up`                                                                                         | engine.log 20:53:11                       | **FAIL (P1-3)**                |
| 4f  | `**<ext>` directed pickup                                                                         | picker takes the call                        | pickup found the call and then refused: `mediad refused bridge-sessions (unknown_session)`                                                                                            | engine.log 20:57                          | **FAIL (P0-1, fixed)**         |
| 4g  | `*8` group pickup                                                                                 | picker takes the call                        | same refusal                                                                                                                                                                          | engine.log 20:57                          | **FAIL (P0-1, fixed)**         |
| 5a  | Conference 4400, three browser participants                                                       | mixer audio on all three                     | all three non-zero and identical (`packets 31, energy 0.0706`)                                                                                                                        | `s5-conference.mjs`                       | PASS                           |
| 5b  | Moderator mute                                                                                    | 2xx                                          | 201                                                                                                                                                                                   | `s5-conference.mjs`                       | PASS                           |
| 5c  | Moderator kick                                                                                    | member leaves                                | 201, `memberCount 3 → 2`                                                                                                                                                              | `s5-conference.mjs`                       | PASS                           |
| 5d  | Room lock                                                                                         | 2xx                                          | 201, `locked: true`                                                                                                                                                                   | `s5-conference.mjs`                       | PASS                           |
| 5e  | Entry/exit tone + join announcement                                                               | a beep in the room                           | every join and leave: `mediad refused start-playback (unknown_session): no session <bridgeId>` — and the SAME id for all three joins                                                  | engine.log 21:07:46/52/58                 | **FAIL (P2-1)**                |
| 5f  | PIN gate                                                                                          | a wrong PIN is not admitted                  | inconclusive from the browser; the engine logged no PIN decision                                                                                                                      | —                                         | NOT PROVEN                     |
| 6a  | **Custom voicemail greeting plays** (re-test after the prompt fix)                                | the caller hears it                          | `playback started … frames:200` = **4.00 s exactly**, the uploaded WAV's duration, then `.beep`                                                                                       | mediad.log 21:21, 20:33:45                | **PASS**                       |
| 6b  | Message filed, unread count                                                                       | rises                                        | rows 10→11, `newCount` 10→11                                                                                                                                                          | `s6-voicemail.mjs`                        | PASS                           |
| 6c  | Mark read → MWI                                                                                   | count falls, MWI fires                       | `newCount` 11→10; live `mwi.updated … reason:"message-read"`                                                                                                                          | `s6-voicemail.mjs`                        | PASS                           |
| 6d  | **Delete → MWI clears**                                                                           | row gone, MWI fires                          | 200; rows 11→10; MWI event delivered                                                                                                                                                  | `s6-voicemail.mjs`                        | PASS                           |
| 6e  | Voicemail forward / copy                                                                          | forwards to another box                      | **404 — no such route exists**                                                                                                                                                        | `s6-voicemail.mjs`                        | **ABSENT (P2-2)**              |
| 7a  | Tenant B's DID `+15005550301` → its own extension                                                 | rings tenant B's 1001                        | rang **1001@tenbmtudfvz1.local.test in 6 ms**, answered 200 OK                                                                                                                        | `apps/sipd/e2e_multiorg_test.go`          | PASS                           |
| 7b  | My DID `+15005550201` → my extension                                                              | rings 1204                                   | rang **1204@rt2mtuiyokf.local.test in 7 ms**, answered 200 OK                                                                                                                         | same                                      | PASS                           |
| 7c  | **No cross-org leakage, live**                                                                    | the other tenant's phone sees nothing        | neither DID produced an INVITE at the other tenant's registered phone                                                                                                                 | same                                      | PASS                           |
| 7d  | **No cross-org leakage in the CDR**                                                               | one leg each, correctly attributed           | rt2's CDR carries only `+15005550201`; tenant B's only `+15005550301`; one A-leg each, `answered`/`NORMAL_CLEARING`                                                                   | `/api/v1/cdr`                             | PASS                           |
| 8a  | Outbound through the trunk, caller-ID policy                                                      | the extension's own CLI on the wire          | `From: "RT2 Alice" <sip:+15005550999@carrier.rt2.test>` — exactly the extension's `outboundCallerIdName`/`Number`, in the trunk's `sipDomain`; answered 200                           | `carriersniff.mjs` → `/tmp/rt2-sniff.log` | PASS                           |
| 8b  | **Toll-class refusal** for a disallowed international number                                      | refused                                      | `caller 1201 (national) may not take any route matching 011442071234567` → `hangup:OUTGOING_CALL_BARRED`, sipd cause 52                                                               | engine.log / sipd.log 21:12:56            | PASS                           |
| 8c  | The same phone on an allowed national route                                                       | routed to the trunk                          | `matched outbound route "RT2 National"` → `targetKind:"trunk"`                                                                                                                        | engine.log 21:12:34                       | PASS                           |
| 9a  | `*5` parks a live call                                                                            | parked, hearing hold music                   | parked; the parked party kept receiving audio (336 packets / energy 6.47)                                                                                                             | `s9-park.mjs`                             | PASS                           |
| 9b  | Dialling the orbit retrieves it                                                                   | the retriever is bridged in                  | orbit **4201**, 246 packets / energy 4.57; engine: `retrieved the call parked on orbit 4201`                                                                                          | `s9-park.mjs`                             | PASS                           |
| 9c  | **Timeout recall to the parker**                                                                  | rings the parker                             | nothing rang; engine: `a timed-out parked call could not be returned to its parker`, `parkedByNumber:"1203"` — **the parked party, not the parker (1201)** — and the call was dropped | engine.log 21:10:49                       | **FAIL (P1-4)**                |

**Totals: 34 PASS · 9 FAIL · 1 absent · 1 capability gap · 1 not proven.** Two of the nine failures
were fixed and re-proved live during the run (4a/4b); one more is fixed and waits on a restart (4f/4g).

## Findings

### P0-1 — call pickup never connects: the caller's leg is bridged before it is answered (FIXED)

Both `**<ext>` and `*8` found the ringing call, hung the ringing phone up — and then refused:

```
pickup refused: the picked-up call could not be connected: MediaCommandRefusedError:
mediad refused rpc.media.v1.bridge-sessions (unknown_session):
rtp: no such session on this instance: 01a087f5-5c10-7b94-9a1f-f1bbbf783444
```

That session id is the **caller's A-leg** (`sipd.log`: `from:"1201" to:"1204"`). On the split media
plane `SplitPlanePort.answer` is what ALLOCATES a leg's mediad session
(`apps/engine/src/media/split-plane.port.ts:419`), so a leg that is still ringing has none.
`CallControl.pickup` answered only the picker and bridged the caller unanswered — which cannot work
on this driver, and which also left the caller hearing ringback after their call had been taken. It
is invisible on the ARI driver, where the channel exists from the start.

The reason no test caught it: the pickup fixture built the caller leg with the default
`isAnswered: true`, which the caller of a ringing phone never is.

**Fix applied** — `apps/engine/src/calls/call-control.ts`: answer the caller's leg too, guarded on
`isAnswered` so an already-answered caller is not re-answered. Fixture corrected and three
assertions added (`call-control.spec.ts`), plus an `answered()` accessor on the fake media port so
"which legs does this feature answer" is assertable at all (`media-port.fake.ts`).
**Needs an engine restart to verify live.**

### P1-1 — the call-flow and time-condition toggle codes cannot be dialled

`call_flow.featureCode` (`*65`) and `time_condition.overrideFeatureCode` (`*64`) are validated on
write, screened for collision by the compiler (`compile.ts` `reportToggleCodeCollisions`) and shown
in the admin UI as the way a supervisor flips night mode from a handset. They reach neither
`artifact.internal.featureCodes` nor `artifact.internal.numbers`, so `resolveInternal` does not match
them and the call falls through to the OUTBOUND context:

```
"reason":"no outbound route matched *65","entryNodeId":"hangup:UNALLOCATED_NUMBER"
```

A `*` code can never be an outbound number, so this is unambiguous. Both REST paths
(`POST /call-flows/:id/toggle`, `POST /call-flows/time-conditions/:id/override`) work perfectly and
were acked in ~50 ms — the feature is only unreachable from a telephone, which is the one place it
is meant to be used. Not fixed: the fix is in `packages/routing` (compile the two codes into the
feature-code table with a `call-flow-toggle` / `time-condition-override` action, and give the walker
those two cases), which is outside my area. See **Cross-area needed**.

### P1-2 — `directDialEnabled` on an IVR is accepted, compiled, and then refused by the engine

The DTO takes it, the compiler emits it (`"directDialEnabled":true` is in my artifact verbatim), and
the walker declines:

```
IVR "01a087c7-…" has direct dial enabled, which needs an internal resolve the walker cannot
make yet; 1203 was treated as invalid
```

`plan-walker.ts:3030` is explicit about it. The caller is then charged a failure against
`maxFailures` and lands on the invalid branch — measured: dialling `1203` at menu 4700 rang **1205**.
A tenant who ticks "let callers dial an extension" gets a menu that misroutes every direct dial and
no warning anywhere: the compiler emits no diagnostic for it. The honest minimum, short of building
the second resolve, is a compile-time warning; the field currently promises a feature that does not
exist. Not fixed (the resolve seam is a walker/orchestrator change I did not want to make blind).

**This answers the brief's question directly**: the compiler _can_ express single-digit options plus
direct dial with an inter-digit timeout — options `1` and `2` both routed correctly on a `maxDigits 4`
menu — and it is the ENGINE that cannot execute the direct-dial half.

### P1-3 — shared lines are configurable, compile, and are not implemented

`POST /api/v1/shared-lines` and its appearances all succeed, and the artifact carries a complete
`shared-line` node with both appearances, `strategy`, `ringTimeoutSeconds`, `holdRecallTimeoutSeconds`
and `bargeInEnabled`. Dialling 4500:

```
node kind "shared-line" is not implemented yet; announced and hung up
```

`plan-walker.ts` has no `case "shared-line"`, and the `default` arm's exhaustiveness check is
defeated by an `as { kind: string }` cast, so nothing fails to compile. `shared-line-registry.ts`
implements seize/hold/recall against a KV bucket in full and **no call-path code calls it**. Seize,
hold and retrieve-from-the-other-appearance are therefore untestable, not broken. sipd's
`Call-Info: …;appearance-index=` is real and correct; the BLF side carries an open
`TODO(SLA)` (`apps/sipd/internal/subscribe/handler.go:748`).

Severity is P1 rather than P2 because the admin UI offers the whole feature and a tenant who
configures it discovers by calling it that it announces and hangs up.

### P1-4 — a park timeout recalls the wrong party, and drops the call

Lot timeout 20 s, timeout destination 1201. 1203 called 1201; **1201** pressed `*5`. On timeout:

```
"parkLotId":"01a087c7-…","slot":4201,"parkedByNumber":"1203","status":"hangup",
"msg":"a timed-out parked call could not be returned to its parker"
```

`parkedByNumber` is **1203 — the party that was parked**, not 1201 the parker. `CallControl.park`
takes it from `peerOf(leg).callerIdNumber` (`call-control.ts:937`); on a B-leg, `callerIdNumber` is
the _originating_ party's id, not the extension the leg reaches. The recall then routes the parked
call to the number it is already on, which resolves to `hangup`, and the caller is dropped rather
than returned to anybody. A customer left on hold past the timeout is disconnected.

Not fixed: the correct identity is `destinationNumber` when the parker's leg was originated and
`callerIdNumber` when it arrived, and `ControlledLeg` carries no direction flag to tell them apart.
Adding one touches the orchestrator's leg aggregate, which another agent is exercising; I would
rather hand this over than guess and break the A-leg case. A control run parking from the caller's
side produced no park event at all, which is a second thread worth pulling and which I did not
chase.

### P1-5 — the browser softphone ignored the auto-answer headers, so paging and intercom just rang (FIXED)

The whole chain is intact and I verified each link: the engine sets
`PJSIP_HEADER(add,Alert-Info)` / `(add,Call-Info)` (`apps/engine/src/routing/auto-answer.ts`), the
split-plane port translates exactly those two variables into real headers on the sipd originate
(`split-plane.port.ts:571`), and sipd appends them to the INVITE (`invite/originate.go:371`). Every
desk phone in `apps/api/src/provisioning/catalog/templates/` is provisioned to honour one of them.
The browser softphone honoured neither — there was no reference to `Alert-Info`, `answer-after` or
auto-answer anywhere in `apps/web`. Measured before: paging 4300 left both members `ringing:true`
with **0 packets**, and the engine noted `paging group "RT2 Page All" was opened but none of its 2
members answered`; `*80` noted `extension 1204 did not auto-answer the intercom (no answer)`. The
admin UI meanwhile tells the operator "the handset itself must also be configured to auto-answer,
which is a phone setting" — advice a browser tab cannot act on.

**Fix applied** — new `apps/web/lib/softphone/auto-answer.ts` (`wantsAutoAnswer`, matching
`info=alert-autoanswer` on `Alert-Info` loosely enough to survive Snom's decorative URI, and
`answer-after=` on `Call-Info` **only when the value is 0**, so a delayed answer-after never opens a
tab's microphone later), wired into `jssip-adapter.ts`'s `newRTCSession` handler behind a guard so a
missing request cannot throw inside the handler and take the whole incoming-call path down.
`INCOMING_CALL` is still emitted, so a page appears in the call UI and has a Hang up button. Specs:
`auto-answer.spec.ts` (6 cases, including the shared-line `appearance-index` `Call-Info`, which must
NOT auto-answer) and two adapter cases.

**Verified live** (web is `next dev`, so it was hot-reloaded): paging 4300 →
`{"1202":{"active":true},"1203":{"active":true}}` with **384 packets / energy 7.24** on each;
`*801204` → active, 392 packets / energy 7.35; and a plain call to 1202 still rings rather than
auto-answering.

### P1-6 — a paging feature code with its group pinned is unreachable

`FEATURE_CODE_PARAM_SCHEMAS` documents `paging.params.groupId` as "Pin the group this code announces
into, or omit it and let the dialed digits choose", and `featureCodeTarget` resolves it into a
`targetNodeId` so the node needs no live argument. But `compile.ts:3068` writes
`argumentMode: FEATURE_CODE_ARGUMENT_MODE[entry.action]` from a static per-action table that never
looks at `params`, so `paging` stays `required`, and `matchFeatureCode` skips the exact match
(`feature-codes.ts:217`). Dialling the bare `*81` therefore produces `no outbound route matched *81`.
`call-park` is unaffected only because its mode happens to be `optional`. Cross-area
(`packages/routing`); the one-line shape is in **Cross-area needed**.

### P2-1 — conference entry/exit tones and join/leave announcements never play on the split plane

Every join and every leave:

```
conference room 4400 could not play its join announcement: mediad refused
rpc.media.v1.start-playback (unknown_session): no session 01a087ff-8c9f-… on this instance
```

`announceConferenceArrival` plays at the BRIDGE id (`plan-walker.ts:4167`), whose doc comment says
"`mediad` mixes a playback into the room the same way" — it does not: mediad's `start-playback` takes
a media SESSION, `split-plane.port.play` forwards the id unchanged, and there is no room-level
playback command in `apps/mediad/internal/control/handlers.go`. Note the id is **identical across all
three joins**, which is what a bridge id looks like when it is being used as a session id. So
`entryToneEnabled`, `exitToneEnabled` and `announceJoinLeave` are all decorative on this media plane,
and a participant cannot tell that a third party joined a private call. Cross-area (mediad, Go).

### P2-2 — there is no voicemail forward or copy

`POST /api/v1/voicemail-boxes/:id/messages/:messageId/forward` is a flat 404 (`Cannot POST`), and
there is no equivalent verb on the messages controller. Listed because the brief asked for it: the
feature does not exist rather than being broken.

### P2-3 — outbound identity is `From` only: no P-Asserted-Identity, and no CLIR at all

The wire capture is complete: `From: "RT2 Alice" <sip:+15005550999@carrier.rt2.test>` and nothing
else — no `P-Asserted-Identity`, no `Remote-Party-ID`, no `Privacy`. Most carriers authenticate a
trunk's identity on PAI and treat `From` as display only, so a deployment's chosen caller ID may
simply be overwritten upstream. Separately, there is no `callerIdPolicy` / `clir` / `privacy` field
anywhere in the product, so "withhold my number" cannot be expressed per call, per extension or per
route. Both are design gaps rather than defects, and both belong to whoever owns outbound routing.

### P2-4 — a new organization gets ZERO feature codes

`DEFAULT_FEATURE_CODES` in `packages/routing/src/feature-codes.ts` is a complete 19-entry catalogue
(`*97`, `*78`, `*8`, `*43`, …), is exported, and is asserted by its own spec — and **no production
code imports it**. The only references outside that file are its spec and the package's `index.ts`.
Proved on a brand-new organization: `GET /api/v1/feature-codes` returned 0 rows, and every code in
this report had to be created by hand before it could be dialled. Every tenant therefore ships with
no voicemail code, no DND code and no pickup code until an administrator types all nineteen, and
nothing in the UI says so.

### P2-5 — the echo test is a named capability gap, and the message is exemplary

`*43` refuses with `split-plane cannot echo: it needs Asterisk's Echo() application, which neither
the sipd signalling plane nor the mediad relay provides … Set ENGINE_MEDIA_DRIVER=ari to serve this
call with Asterisk, or see plans/mediad-design.md §2`. Recorded as a gap rather than a defect: it is
a deployment fact, stated with its remedy. The one thing missing is upstream — nothing stops an
administrator creating an `echo-test` feature code on a deployment that cannot serve it.

### P2-6 — holidays are a documented concept with no resource behind them

`time-conditions.dto.ts:26` says "Holidays live here", and a holiday is expressible: a rule whose
predicate is a `dateRange`. There is no holiday table, endpoint or UI concept anywhere in the repo.
It works (scenario 1e passed, and routing flipped 232 ms after the write), but a tenant with twelve
public holidays maintains twelve hand-built rules and gets no "is today a holiday?" answer from the
API. Worth a product decision, not a bug.

### P2-7 — `voicemailEnabled` on an extension does not create a mailbox

Creating five extensions with `voicemailEnabled: true` produced five compiler warnings —
`Extension 1201 has voicemail enabled but no mailbox; unanswered calls are released instead` — and no
mailboxes. The diagnostic is excellent and the behaviour is arguably correct, but the extension DTO's
flag reads like it provisions one. A tenant who ticks the box gets calls released instead of filed
until they also visit a second screen.

## Fixes applied

| File                                         | Change                                                                                                                                                   | Test                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/engine/src/calls/call-control.ts`      | **P0-1**: `pickup` answers the caller's leg (guarded on `isAnswered`) before bridging, because on the split plane `answer` is what allocates the session | `call-control.spec.ts` (+2 cases, +1 assertion) |
| `apps/engine/src/calls/call-control.spec.ts` | the pickup fixture's caller is now UNANSWERED, which is what the caller of a ringing phone is; pins the answer order                                     | —                                               |
| `apps/engine/src/media/media-port.fake.ts`   | `answered()` accessor, mirroring `hungUp()` — which legs a feature answers is part of what it means                                                      | —                                               |
| `apps/web/lib/softphone/auto-answer.ts`      | **P1-5, new**: `wantsAutoAnswer` — the browser half of the auto-answer agreement                                                                         | `auto-answer.spec.ts` (6 cases)                 |
| `apps/web/lib/softphone/jssip-adapter.ts`    | auto-answers a paging/intercom INVITE, guarded so a missing request cannot kill the incoming-call path                                                   | `jssip-adapter.spec.ts` (+2 cases)              |
| `apps/sipd/e2e_multiorg_test.go`             | **new**, `//go:build e2e`: two tenants, two DIDs, one carrier socket — each DID reaches its own tenant and NOT the other's                               | itself                                          |

## Needs restart to verify

1. **engine** — the P0-1 pickup fix. Re-run afterwards: `s4b.mjs` (both pickups must connect with
   audio on the picker) and `s9-park.mjs`.
2. **web** — already live via `next dev`, and re-proved on the wire (see P1-5).
3. `apps/sipd/e2e_multiorg_test.go` needs no restart; it drives the running stack.

## Cross-area needed

- **`packages/routing`, P1-1**: compile `call_flow.featureCode` and `time_condition.overrideFeatureCode`
  into `artifact.internal.featureCodes` (two new actions, or one `toggle` action carrying the target
  id) and give `plan-walker.ts` the two cases. Today they are validated, collision-screened, offered
  in the UI, and unreachable from a telephone.
- **`packages/routing`, P1-6**: in `compileFeatureCodes`, an entry whose `featureCodeTarget` resolved
  a `targetNodeId` should be emitted with `argumentMode: "optional"` rather than the action's static
  mode, so a pinned `paging.params.groupId` makes the bare code dialable — which is exactly what the
  DTO promises.
- **`apps/mediad` (Go), P2-1**: a room-level playback command, so a conference's entry/exit tone and
  join/leave announcement have somewhere to go. Until then those three columns do nothing on the
  split plane and `plan-walker.ts:4120`'s comment about it is wrong.
- **`packages/routing`, P1-2 (minimum)**: a compile diagnostic when `directDialEnabled` is set, since
  the engine cannot honour it. The real fix is the walker's second resolve.

## Measurements

- Registration (browser → sipd over WSS) and a plain 1201→1202 call: **ring in 431 ms**, two-way
  audio 23 packets / energy 0.377 and 0.385.
- Call-flow toggle: REST ack **51 ms**; the next call took the new branch immediately.
- Time-condition rule edits: two writes acked in **61 ms**; the next call took the new branch **232 ms**
  after dialling — comfortably the brief's "within a second".
- Inbound carrier DID → a registered extension: **6 ms and 7 ms** (two tenants, same carrier socket).
- Dial-by-name lookup, spelling plus one accept digit: **36 s** — dominated by the fixed prompt
  sequence (greeting, name, "please press", digit, suffix) rather than by anything slow.
- IVR on a `maxDigits 4` menu: 32 s for a single-digit option, because the entry only ends on the
  2.5 s inter-digit timeout — the cost of enabling direct dial at all, worth knowing before a tenant
  raises `maxDigits` on a busy menu.
- Paging fan-out after the fix: both members answered and were receiving **384 packets / energy 7.24**
  within 10 s of the page starting.

## What I could not test, and why

- **Shared-line seize / hold / retrieve** (P1-3) — the node is not implemented, so there is nothing to
  drive. The registry that would implement it is written and unwired.
- **The conference PIN gate** (5f) — a wrong PIN produced 62 packets of prompt audio and the engine
  logged no PIN decision either way, so I cannot say from outside whether it was refused or admitted.
  Proving it needs either an engine log line on the PIN branch or a spec; I would not report a
  security control as passing on ambiguous evidence.
- **Two-way audio on the inbound carrier legs** (7a/7b) — the routing, answer and isolation are proven
  and the CDR is clean, but my carrier UA's RTP counters stayed at zero, which I did not chase.
- **The outbound trunk leg's audio** (8a) — my sniffer answers 200 with no SDP, deliberately: the
  claim there is the caller-ID policy on the wire, which it captures exactly.
- **The second park orientation** (parking from the caller's side) produced no park event at all. It
  is either a second defect or a harness miss and I ran out of budget to separate them; noted inside
  P1-4 rather than reported as a finding.

## Harness notes (three of my own bugs, so nobody re-measures them)

- `press()` must target the in-call keypad, whose buttons are named by the bare digit; the idle
  dialer's are `"2 ABC"`. Filtering by an enclosing panel matched nothing — the exact-name match on
  its own is correct, as `FIX-ivr-dtmf.md` already found.
- The **directory gather takes `maxDigits: 10`**, so accept-digit presses sent during the offer are
  appended to the spelled name and it never matches. Terminate the spelling with `#`, then press the
  accept digit (`1`) once per offer. Both directory probes pass that way; two earlier "failures" were
  entirely mine.
- Listing a NATS KV bucket by `await`ing a `get` inside `for await (… of kv.keys())` **silently ends
  the listing after one key** — the exact trap `did-index.publisher.ts:293` documents. It made me
  believe for a while that DID publishing was broken platform-wide. It is not: both DIDs were indexed
  correctly the whole time. Drain the keys first.
- A probe must wait for the DIALER to come back after a hangup, not just click Hang up: the in-call
  panel replaces it, and the next `fill()` otherwise times out on a missing placeholder.

## Verification

| Check                                                                                 | Result                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/engine run typecheck`                                   | pass                                                                                              |
| `pnpm --filter @optimiq-voice/engine run test`                                        | **1730 pass, 12 skip, 0 fail**, 3915 expect(), 78 files                                           |
| `pnpm --filter @optimiq-voice/web run typecheck`                                      | pass                                                                                              |
| `pnpm --filter @optimiq-voice/web run test`                                           | **855 pass, 0 fail**, 2736 expect(), 41 files                                                     |
| `pnpm exec oxlint apps/engine/src/calls apps/engine/src/media apps/web/lib/softphone` | exit 0, no findings                                                                               |
| `pnpm exec oxfmt` (7 files touched)                                                   | clean                                                                                             |
| `cd apps/sipd && gofmt -l .`                                                          | clean                                                                                             |
| `cd apps/sipd && go vet -tags e2e ./...`                                              | pass                                                                                              |
| live                                                                                  | `TestE2EMultiOrgInboundDIDs` **PASS** (both tenants); paging/intercom re-proved after the web fix |

`go test -race ./...` for sipd was not run: my only Go change is a new file behind the `e2e` build
tag, which that suite does not compile, and it was exercised against the live stack instead.

No git state was touched and nothing was committed.
