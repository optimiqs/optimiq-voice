# FIX-pkg-domain — packages/routing, telephony, telnyx, media-ari

## packages/routing

- **[P0] `planNodeReferences` omits four branch fields — FIXED.** `plan.ts`: `queue` now reports
  `exitNodeId`; added `case "call-flow"` (both `dayNodeId`/`nightNodeId`), `case "stream"`
  (`fallbackNodeId`), `case "dial-by-name"` (every `entries[].targetNodeId` + `timeoutNodeId`);
  `default:` replaced with explicit `voicemail | conference | external | application | hangup → []`
  so the next kind is a compile error. `compile.spec.ts`: new `branchy` snapshot exercising all four
  kinds with DISTINCT targets, plus a property test that walks each node's own object graph for any
  `*NodeId` field at any depth (shape-derived, not a hand list) and asserts `planNodeReferences`
  reports it, with a guard that the snapshot actually produced those kinds. Verified it fails on the
  old code (reverted the three cases → 1 fail).
- **[P1] Follow-me hops skip the route's translation ruleset — FIXED.** `compile.ts`
  `followMeTrunkTarget` now runs `applyTranslationRuleset(rule.translation, dialedNumber)` after the
  inline strip/prepend, falling back to the untranslated number on overflow, exactly as
  `resolveOutbound` does. Doc comment updated. Test in `follow-me.spec.ts`.
- **[P1] Inbound caller-id can emit non-dialable characters — FIXED.** `translations.ts`
  `applyTranslationRuleset` now checks the OUTPUT of each rewrite against
  `REPLACEMENT_LITERAL_PATTERN` and abandons the pipeline (returning the input) with a new
  `undialable` flag set alongside `overflowed` — chosen so every existing caller, all of which
  already fall back on `overflowed`, is safe unchanged. Closes both the `$1`-over-carrier-input hole
  and the `$$1` literal-dollar case in one place. Both diagnostic messages in `resolve.ts` now say
  which refusal happened. Three tests in `translations.spec.ts`.
- **[P1] No ReDoS bound on tenant regexes — FIXED.** New `unsafeRegexDetail()` in `patterns.ts`:
  rejects a group repeated without an upper bound (`*`, `+`, `{n,}`) whose body contains an inner
  unbounded quantifier or an alternation — `(a+)+`, `(a*)*`, `(a|a)*`. Character-class and
  escape-aware. Wired into `regexCompileError` (so `compilePattern` raises `invalid-regex`) and into
  `validateTranslationRule`. Tests in `patterns.spec.ts` and `translations.spec.ts` cover the
  rejections and confirm ordinary dial-plan shapes and bounded repetition are untouched.
- **[P1] Diagnostics allocated on every resolve — SKIPPED (cross-area).** See "Cross-area needed".
- **[P2] `compileVoicemailPrefixes` false feature-code clash — FIXED.** New
  `featureCodeWouldConsume(table, value)` in `feature-codes.ts`, next to `matchFeatureCode` and
  matching its rule exactly; used at all three sites (`compile.ts` 2291 / 3009 / 3155), which removes
  the copy that omitted the `argumentMode` guard. Test: `*9` + voicemail prefix `*99` no longer warns.
- **[P2] Invalid queue exit key vanished silently — FIXED.** `queueNode` compares the raw column
  against `normalizeExitKey`'s answer and raises `queue-exit-key-without-destination` naming the
  value and the allowed set. Test in `compile.spec.ts`.
- **[P2] `reportInboundShadowing` allocated per iteration — FIXED.** `rules.slice(0, index)` → an
  index loop.
- **[P2] `translationRuleset` linear scan — FIXED.** Added `translationRulesetInputsById`, populated
  in `compileTranslationRulesets`, mirroring `timeConditionInputsById`.
- **[P2] Two artifact fields structurally always `true` — FIXED (documented, not dropped).**
  `InboundDidDefault.enabled` and `ExtensionIndexEntry.enabled` carry a one-line doc saying the
  compiler drops disabled rows, and `resolveInbound`'s `didDefaults` read carries the matching note.
  Not removed: `ExtensionIndexEntry.enabled` is read by `apps/api/src/pbx/sip-credentials/`, which is
  another agent's area.
- **[P2] Over-long `emergencyNumbers` silently dropped valid entries — FIXED.** `emergency.ts` now
  filters first and caps second (`validEmergencyNumbers` / `acceptedEmergencyNumbers`), and exports
  `cappedEmergencyNumbers()` naming the valid entries the cap discarded; `reportInvalidEmergencyNumbers`
  raises a warning for each. Three tests in `emergency.spec.ts`.

## packages/telnyx

- **[P0] Body read outside the retry `try` — FIXED.** `transport.ts`: `await response.text()` moved
  inside the same `try` as `doFetch`, so a mid-body abort or socket reset records
  `lastTransportCause`, fires `onAttempt`, and retries per policy instead of escaping as a raw
  `AbortError`/`TypeError`. Two tests in `client.spec.ts` (typed error; retried and reported 0–3).
- **[P0] `Retry-After` trusted without a bound — FIXED.** `RetryPolicy` gains `maxRetryAfterMs`
  (60s) and `maxTotalMs` (120s); `backoffDelayMs` clamps the carrier floor to `maxRetryAfterMs`, and
  `request()` checks a total deadline before every sleep (`wouldPassDeadline`) on both the transport
  and the status retry path. The final `TelnyxTransportError` now reports attempts actually made
  rather than `maxAttempts`. `RetryPolicy` is consumed only as `Partial<RetryPolicy>` merged over the
  default, so the added fields are source-compatible. Two tests in `retry.spec.ts`.
- **[P1] 5xx retries on creation create orphans — FIXED.** `retryable: false` on
  `POST /credential_connections` and `POST /outbound_voice_profiles`, with the reasoning corrected in
  both comments (Telnyx honours no `Idempotency-Key` on these endpoints — already pinned in
  `retry.ts`/`number-orders.ts` against the OpenAPI doc — so retrying cannot be made idempotent).
  Added `outboundVoiceProfiles.findByName(name)` as the reconciliation read (exact match filtered
  client-side over the `contains` filter). Two tests asserting exactly one attempt each.
  _Not added:_ `credentialConnections.findByUserName` — there is no `GET /credential_connections`
  route in the in-package fake and no list filter pinned in `reference/telnyx-api.md`, so it would be
  guesswork. With `retryable: false` the orphan-then-422 sequence can no longer occur.
- **[P1] List endpoints silently truncate — FIXED (additively).** `phoneNumbers.listPage()` returns
  `{ data, meta }`; `list()` is now a one-liner over it and keeps its existing signature, because
  changing it would break `apps/api` which I may not edit. `outboundVoiceProfiles` and
  `numberOrders` unchanged — see "Cross-area needed".
- **[P2] `findByCustomerReference` ordering — FIXED.** Now sorts by `created_at` descending in the
  resource (`orderedAt`, missing timestamps last) rather than trusting an undocumented API default;
  doc updated to say so.
- **[P2] `decodeBase64` did not do what its comment claims — FIXED.** Alphabet check
  (`/^[A-Za-z0-9+/]+={0,2}$/`) before the decode, so junk that happens to decode to 64 bytes is
  `malformed-signature` rather than `mismatch`. Test in `webhooks/signature.spec.ts`.
- **[P2] Snake-case body assembly duplicated five times — SKIPPED.** Collapsing
  `updateVoiceSettings`' ~100-line nested spread-ternary into a shared `omitUndefined` is a large
  refactor with no behavioural gain and a real risk of silently dropping a field. Flagged, not done.

## packages/media-ari

- **[P0] Open-timeout path abandoned the socket — FIXED.** New `closeSocket(socket, reason)` helper
  (also used by `close()`); the open timer now closes the socket before
  `teardownAndScheduleReconnect`. Test asserts `FakeSocket.closedWith` is set.
- **[P0] A failed `start()` left a live reconnect loop — FIXED.** `start()` wraps `connect()` and
  calls `this.close()` before rethrowing, so a failed start leaves the stream `closed` and
  restartable. Test asserts status `closed`, no further sockets after a tick, and that a second
  `start()` actually connects.
- **[P1] The 10s timeout did not cover the response body — FIXED.** `http-client.ts`: the 204 check
  and `await response.text()` moved inside the `try`, with `clearTimeout` in the `finally` wrapping
  both. Test with a stream that errors mid-body.
- **[P1] An abort reported as an unreachable server — FIXED.** `AriTransportError` gains
  `timedOut: boolean`, set from `controller.signal.aborted`, with a distinct message. Test covers
  both branches.
- **[P2] No cap on reconnect attempts — FIXED (additively).** `BackoffOptions.maxAttempts?`; on
  exhaustion the stream stops, reports a terminal `AriSocketError` and sets status `closed`.
  `undefined` remains the default, now documented as a deliberate choice rather than an absence.
- **[P2] `channelOfEvent` returns the peer for `Dial` — FIXED (documented).** The JSDoc now states
  it returns the B-leg and that an A-leg-keyed consumer must read `event.caller` itself, naming the
  `dialstatus` failover case. Signature unchanged.
- **[P2] `encodeSegment` had no callers — FIXED.** All 42 inlined `encodeURIComponent` calls across
  the six resource files now go through `encodeSegment`.

## packages/telephony

- **[P1] A complete feature code lost when the next digit doesn't extend it — FIXED.** The machine
  latches the longest complete argument-less code while a longer row is still live; a digit that
  matches nothing fires the latched entry and returns the trailing digits as a new
  `MidCallFeatureStep.passThrough` rather than abandoning everything. Only argument-less codes are
  latched (for an argument-taking code the trailing digits are genuinely ambiguous) — documented on
  the field and in the class doc's case list. Two tests, including that a capture with no prior exact
  match still abandons.
- **[P1] `executing` had no watchdog — FIXED.** New `MidCallFeatureSettings.executionTimeoutMs`
  (30s); `beginExecuting` sets the deadline and returns `wakeAtMs`, honouring the
  `MidCallFeatureStep` contract it was contradicting, and `expire` in `executing` abandons back to
  `idle`. The spec that pinned the no-timer behaviour asserted the wrong thing and was rewritten
  (`asks for no timer once it is executing` → watchdog tests).
- **[P1] `verbRequiresMediaPath` admits hold/park on an early-media leg — FIXED.** New
  `ANSWERED_VERBS` + `verbRequiresAnswer()` (a subset of `MEDIA_PATH_VERBS`, so existing callers stay
  correct), exported from `index.ts`, documented against `VALID_CALL_STATE_TRANSITIONS` having no
  `early → held` edge. Tests tie the two tables together. _The engine's guard still has to call it —
  see "Cross-area needed"._
- **[P2] Park timeout had no legal edge during a retrieval — FIXED.** `retrieving → timed-out` added
  with the race documented in the invariant list; `park.spec.ts`'s "times out only from parked" test
  pinned the bug and was rewritten.
- **[P2] `channel.hangup` is the milestone for two machines — SKIPPED (cross-area).** Renaming a
  milestone value is a contract change for `packages/cdr-db`, outside my area.
- **[P2] `DeviceStateChangedEvent` is not a `CallEventBase` — SKIPPED (cross-area).** Either fix
  changes the `CallEvent` union shape for every consumer (engine, cdr-db).
- **[P2] Caller identity unstructured — SKIPPED.** Adding `callerIdPresentation` and an E.164
  predicate is new public API across `ChannelSnapshot`, `CallerIdOverride` and `DialTarget` with
  consumers in apps/*; a large change with no behavioural gain inside this area.

## Additional fixes noticed while in these files

- `TelnyxTransportError.attempts` reported `maxAttempts` even when the loop broke early; it now
  reports attempts actually made.
- `resolve.ts`'s two "would have grown past the length bound" diagnostics were the only explanation
  offered for any abandoned ruleset; they now distinguish overflow from an undialable result.

## Cross-area needed

1. **`apps/api/src/pbx/routing/routing.service.ts:196`** is the only consumer of
   `ResolvedRoute.diagnostics` in the repo (the engine's three call sites ignore them). The audit's
   P1 fix — an `explain?: boolean` defaulting to false on the three `Resolve*Input` types — is
   implementable entirely inside `packages/routing`, but landing it alone silently empties the
   routing inspector's `info` diagnostics until that service passes `explain: true`. I did not apply
   it rather than regress another agent's feature mid-flight. The change is: add
   `readonly explain?: boolean` to `ResolveInboundInput`/`ResolveInternalInput`/`ResolveOutboundInput`,
   gate the 14 `severity: "info"` pushes in `resolve.ts` (and the `timeConditionMessage` formatting)
   on it, leave `warning` unconditional; then `routing.service.ts` passes `explain: true`.
2. **`apps/engine`** — wherever `verbRequiresMediaPath` gates `hold`/`unhold`/`park`/`unpark`, it
   must now also call the newly exported `verbRequiresAnswer(verb)` and check the `answered` flag, or
   the early-media leg still reaches `assertCallStateTransition("early", "held")`.
3. **`apps/api` carrier service** — `outboundVoiceProfiles.create` and
   `credentialConnections.create` no longer retry. A 5xx there is now a single hard failure; the
   caller should reconcile with the new `outboundVoiceProfiles.findByName(name)` before re-creating.
4. **`packages/telephony` + `packages/cdr-db`** — the `channel.hangup` milestone collision (P2)
   needs a distinct name in `CALL_STATE_MILESTONE_EVENTS` and a matching change in the CDR replay.
5. **`packages/telnyx`** — `outboundVoiceProfiles.list` and `numberOrders.findByCustomerReference`
   still discard `meta`. Fixing them the way `phoneNumbers.listPage` was fixed is additive; I left
   them because neither has a caller that can currently be truncated (the first pins `page[size] 50`,
   the second filters on a unique token).

## Verification (exact final counts)

| package   | typecheck             | test                                            |
| --------- | --------------------- | ----------------------------------------------- |
| routing   | pass (tsc, no output) | 859 pass / 0 fail / 2029 expect, 22 files       |
| telephony | pass                  | 242 pass / 0 fail / 1069 expect, 12 files       |
| telnyx    | pass                  | 81 pass / 0 fail / 195 expect, 3 files          |
| media-ari | pass                  | 87 pass / 7 skip / 0 fail / 185 expect, 6 files |

- `pnpm exec turbo run build typecheck --filter=...@optimiq-voice/{routing,telephony,telnyx,media-ari}`
  → **25 successful, 25 total** (includes `@optimiq-voice/api`, `@optimiq-voice/engine`,
  `@optimiq-voice/web` builds and typechecks). No dependent test suites were run.
- `pnpm exec oxlint packages/{routing,telephony,telnyx,media-ari}` → exit 0, no diagnostics.
- `pnpm exec oxfmt packages/{routing,telephony,telnyx,media-ari}` → 125 files, exit 0.
- Diff: 43 files, +1202 / −130. No git state touched.
