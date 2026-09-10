# FIX — AREA=web-followups

Area: `apps/web` (all), plus the web section of `docs/native-calling-deployment.md`.
Verified against the standing stack (`STACK.md`) with the `<scratchpad>/e2e/calling` harness and
three real browser softphones. `apps/web` (`next dev`) was restarted once to pick up a new
`NEXT_PUBLIC_*` variable; no other service was touched.

---

## Task 1 — the `/me/softphone` 200 contract

**FIXED.** The endpoint now answers 200 in every arm (`{configured:true,…}` /
`{configured:false, reason, code, message}`); the hook branched on `status === 404`, so an ordinary
fact about most users arrived as a console error on every screen.

| File                                                   | Change                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/softphone/contracts.ts`                           | `SoftphoneCredentialsResponse` is now the discriminated union (`SoftphoneConfiguredResponse` \| `SoftphoneUnavailableResponse`), plus `SoftphoneUnavailableReason`.                                                                                                                                                      |
| `lib/softphone/credentials.ts`                         | `resolveWssUrl` / `shapeSoftphoneCredentials` take the CONFIGURED arm only. `softphoneUnavailability` gains `reason` and branches on it first, one honest sentence each; the `status`/`code` branches stay as the compatibility fallback for an API that predates the union.                                             |
| `lib/softphone/client.ts`                              | Header rewritten: a rejected promise from here is now a real failure (401/500/offline) and nothing else.                                                                                                                                                                                                                 |
| `app/(app)/_context/softphone-context.tsx`             | One `configured` memo narrows the union; `resolved` no longer enters the try/catch for an unconfigured answer. The `retry` predicate's 404 special case is gone (dead). `refreshCredentials` throws the API's own message when a mid-session refresh comes back unconfigured. New `unavailableFor` on the context value. |
| `app/(app)/_components/softphone/softphone-widget.tsx` | Still hides for `no-extension` / `not-provisioned`; **explains** for `no-realm`, whose caller does hold an extension and whose fix is one Settings edit away.                                                                                                                                                            |

Sentences: `no-extension` → "No extension is assigned to you. An administrator has to assign one
before you can make or take calls here." (no link); `no-realm` → today's sentence + `/settings`;
`not-provisioned` → "Browser calling is not configured on this deployment yet. It needs a SIP secret
key on the API before any extension can register." (no link).

Tests: `lib/softphone/credentials.spec.ts` — six cases over the three reasons, the pre-union
fallbacks and the unshapeable-credentials case.
**Live**: `GET /me/softphone` returns `configured:true` for both the admin and 2001; `/softphone`
loads with **zero** console errors on every phone in every probe below.
_Not exercised live_: the `configured:false` arms — this deployment has no user without an
extension, and manufacturing one means mutating the shared smoke org. The mapping is unit-tested
and the widget gate is a pure function of it.

---

## Task 2 — the live socket

**FIXED, and it needed two changes, not one.**

**(a) The transport path.** `lib/api-client.ts` gains `API_ORIGIN` /
`resolveApiOrigin(pageOrigin, configured?)`, read from `NEXT_PUBLIC_API_ORIGIN` with
`NEXT_PUBLIC_AUTH_BASE_URL` (the auth client's existing variable) as the fallback, empty ⇒
same-origin. `live-context.tsx` opens the socket against it. Spec: `lib/api-client.spec.ts` (4
cases, including a mistyped origin degrading to same-origin rather than throwing inside a socket
constructor).

**(b) The reason it still did not work: React StrictMode was permanently killing the client.**
`LiveProvider` built the `LiveClient` in a `useState` initialiser and destroyed it in the effect
cleanup. `destroy()` is permanent by contract, and StrictMode's development remount runs
cleanup-then-effect — so the second mount inherited a client that was already `stopped` and would
never open a socket again. Measured: the socket opened at +98 ms and closed 0 ms later
("WebSocket is closed before the connection is established"), which is exactly the "Reconnecting"
every live page sat on locally. The client is now created **by** the effect that destroys it, so the
remount builds a live one. This is the bug StrictMode's double-invoke exists to surface, and the
routing agent's fix could not have shown it — they verified a socket was _created_, not that a frame
arrived.

**Live, after both** (`<scratchpad>/e2e/routing/wsprobe3.mjs`):

|                                                         |                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| socket                                                  | `ws://127.0.0.1:3200/api/v1/live` opened at **+125 ms** from `goto` |
| `welcome`                                               | **+11 ms** after open                                               |
| `subscribed` + `snapshot` (`agent-state`, `queue:<id>`) | **+19 ms** after open                                               |
| wallboard                                               | no "Reconnecting"                                                   |
| `/queues`, `/agent-console`                             | no "Reconnecting", no "Waiting for the first frame…"                |
| console errors                                          | none                                                                |

Well inside the one-second bar.

Docs: `docs/native-calling-deployment.md` gains **"Web application: the live socket and the two
deployment shapes"** — reverse-proxied (leave the variables unset) vs split origins (set
`NEXT_PUBLIC_API_ORIGIN`), with the two things that must line up in the split shape (the API's
`trustedOrigins` must contain the _web_ origin, because `live-gateway.ts` checks the handshake
`Origin`; and the session cookie must reach the API origin — automatic across ports on one host,
`AUTH_COOKIE_DOMAIN`/`SAMESITE` across hostnames) and the fact that both are inlined at image build
time. `apps/web/.env.example` documents the variable at the same length.

---

## Task 3 — softphone feature gaps

### (a) Two dialers on `/softphone` — FIXED

The docked widget stands down on `/softphone`, where the page mounts the same dialer in its own
card. **Live**: `getByLabel("Number to dial")` count is **1**; no softphone launcher on the route.

### (b) Transfer — FIXED (blind proven end to end; attended is complete and **blocked by the engine**)

New: `lib/softphone/transfer.ts` (a pure `TransferState`/`transferReducer`, folded into
`SoftphoneState` by `call-state.ts`), four adapter verbs (`transferBlind`, `startConsult`,
`completeTransfer`, `cancelTransfer`) on `SipUserAgent`, their jssip implementation, and a
`TransferControls` panel ("Transfer" → a target field with **Ask first** / **Transfer now**).

The attended path holds the first party BEFORE the consultation takes the microphone, and a
consultation that dies, is cancelled, or whose REFER is refused gives the first party back off hold
and says which step refused. A blind transfer's REFER is acknowledged, not completed — nothing on
the wire says the transferee answered — so the panel says "Transferring to X…", never
"transferred".

Tests: `transfer.spec.ts` (11 cases: both paths, and every guard — a second request while one is in
flight, completing before the consultation is answered, a late `CONSULT_CONFIRMED` for a cancelled
consultation, retry after failure); `jssip-adapter.spec.ts` +6 (the right dialog is REFERred, a
non-established call is not, a refused REFER keeps the call, hold precedes the consultation,
`Replaces` names the consultation, cancel gives the first party back).

**Live — blind transfer, three phones**: 2001→2002 answered; 2001 transfers to 2003; **2003 rang,
answered, and both 2002 and 2003 read inbound `audioLevel` 0.980** — a two-party call between the
transferee and the transfer target, with 2001 gone ("Call ended · Terminated"). sipd logged
`transferred … target:"2003" attended:false`.

**Live — attended transfer**: consultation rings and answers, panel reads
`Talking to 2003 · the first call is on hold`, **Complete transfer** sends the REFER — and the
**engine refuses it**:

```
sipd  WARN "the engine refused the transfer" … attended:true
      reason:"attended_unsupported"
      detail:"this engine cannot honour a Replaces from a consultation it did not broker"
```

The UI then does exactly the right thing: "2003 did not accept the transfer", the first call comes
back off hold, and 2002's audio resumes (`audioLevel` 0.980). The browser half is complete and
correct; see **Cross-area needed §1**.

**One adapter bug found and fixed while doing this**: `wireIncoming`'s busy guard terminated ANY
second session with `486 Busy Here`, including the outgoing consultation — jssip emits
`newRTCSession` synchronously from inside `UA.call`, before the caller has recorded the session, so
the adapter answered its own consultation with a 486 and no consult ever rang. Outgoing sessions are
now recognised as ours (only `call()` and `startConsult()` create one, and each wires what it is
handed); the busy guard applies to INCOMING sessions, which is what it was ever for.

### (c) DND and park from the org's feature codes — FIXED

New `lib/softphone/feature-codes.ts`: reads `GET /api/v1/feature-codes`, indexes the three actions
the phone offers in one pass, first-enabled-wins, disabled treated as absent (the engine will not
route those either). No code ⇒ **no button**: there is no platform default for a feature code, and a
hardcoded `*76` would dial the dial plan's no-match branch on every deployment that chose otherwise.
Park is a **blind transfer** to the park code, not a DTMF burst — the call has to leave this
endpoint for the lot, which is a REFER. DND is dialled while idle. Spec: `feature-codes.spec.ts`
(6 cases).

**Live**: with this org's (empty) `feature_code` table, neither control renders. With `*76`
`do-not-disturb` and `*70` `call-park` created, the dialer showed **"Do not disturb (\*76)"** while
idle and **"Park on \*70"** during a call. Both rows were deleted afterwards; `GET /feature-codes`
is `[]` again, as it was.

### (d) Redial and recents — FIXED

New `lib/softphone/recents.ts`: collapses a CDR page one-per-peer, because a single two-party call
writes up to four `call_legs` and a list rendered from raw legs shows the same colleague three
times, two of them as missed. Spec: `recents.spec.ts` (6 cases). The dialer renders a Redial button
for the last-dialled number and a tappable Recent list.

**Live**: Redial appeared as "Redial 2002" after a call. The recents list rendered for a caller who
holds `cdr.read` — six entries, one per peer (`4020, 2002, 1101, 1102, 4010, 1104`), no console
errors. It does NOT render for a plain extension holder: `GET /api/v1/cdr` demands `cdr.read`, not
`cdr.read.own`, and answers **403** for extension 2001. See **Cross-area needed §2**.

### (e) Go offline, and un-REGISTER on tab close — FIXED

A "Go offline" control (idle + registered only) calls the existing `disconnect`, and a
`pagehide`/`beforeunload` handler calls the same teardown. `SipUserAgent.stop()`'s doc now says what
it is for rather than what it does.

**Live, read off the SIP wire in the page** (`probe-webfix7/8.mjs`): both paths put
`REGISTER … Expires: 0` on the wire and sipd answers `200 OK`. The 200's Contact list contains only
OTHER contacts — ours is gone — so sipd does honour it and the binding really dies. (Three
`no_route` / `connection refused` warnings still appear on a later call to 2001: they are
pre-fix bindings from earlier probes, inside their 600 s lifetime. The sipd-side fix for a WS
binding outliving its transport is still P1-D/P1-1 and belongs to sipd.)

### (f) "On hold by the other party" — FIXED in the browser, **not reachable on this platform**

`CallState` gains `remoteHold`; the adapter reads jssip's `HoldEvent.originator` and emits
`REMOTE_HOLD_CHANGED` for `"remote"` (it previously reported both as one state), and the panel reads
"The other party put you on hold". Tests: reducer + adapter (`remote hold` describe).

**Live: the state never fires**, and the reason is not the browser. The platform is a back-to-back
user agent: A's hold re-INVITE terminates at the engine/mediad media plane and no direction change
is propagated to B's leg, so B's browser is never told. The audit's scenario 7 measured the same
thing from the other side (B reads `Connected` through pure silence). The browser half is correct
and unit-proven; making it visible needs the engine to propagate a hold across the bridge (and, for
the silence, MOH — the audit's P1-3). See **Cross-area needed §3**.

---

## Additional fixes in files I touched

1. `lib/softphone/jssip-adapter.spec.ts` — the fake session's `terminated` type omitted
   `reason_phrase`, so the previous agent's 486 assertion did not typecheck (`tsc` error, present in
   the working tree before I started). Typed, and the fake grew `refer`/`hold`/`unhold`/`isOnHold`
   and a real event registry so the transfer cases can drive it.
2. The consultation-refused-by-its-own-486 bug, above.
3. The StrictMode `LiveClient` destruction, above.

## Skipped

Nothing from the briefs. The `configured:false` live walkthrough and the remote-hold live
walkthrough are recorded above as _not reachable on this deployment_, with the reason and the
unit-level proof, rather than skipped silently.

---

## Cross-area needed

1. **`apps/engine` — attended transfer.** sipd relays the REFER with `attended:true` and the engine
   answers `attended_unsupported` / "this engine cannot honour a Replaces from a consultation it did
   not broker". Since the engine _is_ the B2BUA that brokered both legs, the consultation dialog it
   is asked to replace is one of its own; matching the `Replaces` dialog identifiers to the leg it
   already holds is the work. Until then the browser control is present, honest and useless.
2. **`apps/api` (CDR) — `GET /api/v1/cdr` should honour `cdr.read.own`.** The permission registry
   declares `cdr.read.own`; the controller demands `cdr.read`, so an ordinary extension holder gets
   403 and cannot see their own call history. Scoped to `?extension=<the caller's own>` this is the
   self-service read the softphone's recents list wants (and the same shape as `/me/softphone`).
   The web side already hides the list when the permission is absent.
3. **`apps/engine` / `apps/mediad` — propagate hold across the bridge** (and play MOH, P1-3), so the
   held party's browser is told anything at all. `remoteHold` is wired and waiting.
4. **`.scripts/local-stack/render-env.sh` (infra) — one line.** `web.env` needs
   `NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:${API_PORT}` or every live surface on the local stack
   goes back to "Reconnecting" on the next `up.sh`. I added it to the RUNNING `env/web.env` and
   documented it in `apps/web/.env.example` and the deployment doc, but the generator is not my
   area.

## Verification (exact output)

| Check                                            | Result                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/web run typecheck` | clean                                                                             |
| `pnpm --filter @optimiq-voice/web run test`      | **827 pass, 0 fail**, 2693 expect() calls, 39 files (was 820 before my new specs) |
| `pnpm exec oxlint apps/web`                      | clean (exit 0)                                                                    |
| `pnpm exec oxfmt apps/web`                       | 349 files, clean                                                                  |

Live probes, all under `<scratchpad>/e2e/`: `routing/wsprobe3.mjs`, `calling/probe-webfix.mjs`,
`probe-webfix2.mjs` (blind transfer, 3 phones, audio), `probe-webfix3.mjs` (attended transfer),
`probe-webfix4.mjs` (feature codes, redial, go offline), `probe-webfix6-8.mjs` (registration
lifecycle and the SIP wire), `probe-webfix9.mjs` (recents).

## Stack changes made, and their state

- `apps/web` restarted once (`next dev`, pid recorded in `e2e/pids/web.pid`) to pick up
  `NEXT_PUBLIC_API_ORIGIN`. Still running on 3300.
- `e2e/env/web.env` gained `NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:3200`.
- Two `feature_code` rows (`*76` do-not-disturb, `*70` call-park) created in the smoke org and
  **deleted**; the table is empty again.
- Nothing else created, changed or deleted. No git state touched, nothing committed.
