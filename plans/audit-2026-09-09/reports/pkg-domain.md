# AREA: pkg-domain — packages/routing, telephony, telnyx, media-ari

Read: all of `packages/routing/src` (20.5k lines incl. specs), `packages/telnyx/src`, `packages/media-ari/src`,
`packages/telephony/src`, plus package.json/tsconfig for each.

---

## packages/routing

### [P0] `planNodeReferences` omits four branch fields — closure, reachability and cycle detection are all blind to them (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/plan.ts:871-931`
- Code:
  ```ts
  case "queue": { return compact([node.timeoutNodeId]); }   // exitNodeId missing
  ...
  default: { return []; }   // swallows "call-flow", "stream", "dial-by-name"
  ```
- Problem: the function's own doc (`plan.ts:865-869`) says "One place, so 'did I remember the new branch
  field?' is a question with a single answer. The validation pass, the reachability walk and the closure
  property test all read from here." It does not report:
  - `QueuePlanNode.exitNodeId` (`plan.ts:327`)
  - `CallFlowPlanNode.dayNodeId` / `nightNodeId` (`plan.ts:745-746`)
  - `StreamPlanNode.fallbackNodeId` (`plan.ts:778`)
  - `DialByNamePlanNode.entries[].targetNodeId` (`plan.ts:787`) and its `timeoutNodeId`

  `compile.ts:1885-1889` states the opposite in prose: _"BOTH branches are compiled whatever the mode says,
  **and `planNodeReferences` reports both**, so the inactive one stays reachable."_ The code contradicts the
  comment. `StreamPlanNode`'s doc (`plan.ts:756`) makes the same claim for `fallbackNodeId`.

- Failure scenario, three ways:
  1. **`assertNodeClosure` (`compile.ts:4152-4167`) never checks these edges.** A call flow whose night
     branch resolves to an id that is not in the table compiles clean and the engine meets an absent node
     mid-call — exactly the "call went silent" class the closure check exists to convert into a failed
     compile.
  2. **`reachableNodeIds` (`plan.ts:878-899`) under-reports.** A DID → call-flow → IVR tree returns a
     reachable set of exactly two nodes. Any consumer that prunes or inspects by reachability drops the
     entire flow.
  3. **`detectIvrCycles` (`compile.ts:4104-4149`) walks `planNodeReferences`.** Two IVR menus that loop
     _through_ a call flow or a dial-by-name entry are never reported, which is the case a tenant is most
     likely to build (`main menu → after-hours flow → main menu`).

  The compile-time closure property test (`compile.spec.ts:176`) reads from the same function, so it inherits
  the blind spot and cannot catch any of this.

- Fix: add the missing cases —
  ```ts
  case "queue": return compact([node.timeoutNodeId, node.exitNodeId]);
  case "call-flow": return compact([node.dayNodeId, node.nightNodeId]);
  case "stream": return compact([node.fallbackNodeId]);
  case "dial-by-name": return compact([...node.entries.map((e) => e.targetNodeId), node.timeoutNodeId]);
  ```
  and replace the `default:` with explicit `case "conference" | "voicemail" | "external" | "application" |
"hangup": return []` so the next node kind added is a compile error rather than a silent `[]`.
- Cross-area: none inside the package, but any engine code doing reachability-based plan pruning
  (`apps/engine`) currently sees a truncated graph.

### [P1] Follow-me hops skip the route's translation ruleset, so the same digits dial differently from the ladder than from the keypad (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/compile.ts:1223-1231`
- Code:
  ```ts
  const dialedNumber = applyDigitManipulation(
  	{ stripDigits: rule.stripDigits, prependDigits: rule.prependDigits ?? null },
  	dialString,
  );
  if (dialedNumber === null) {
  	continue;
  }
  return { nodeId: rule.destinationNodeId, dialedNumber };
  ```
- Problem: `resolveOutbound` applies `applyRouteTranslation(rule, manipulated, …)` (`resolve.ts:856-857`)
  after the inline strip/prepend. `followMeTrunkTarget` matches against the _same_ `outbound.rules`, applies
  the _same_ digit manipulation, and then stops — `rule.translation` is never applied.
- Failure scenario: a tenant whose outbound ruleset normalises 10-digit NANP to E.164 (`^(\d{10})$` →
  `+1$1`). A user dials `5551234567` from the keypad and the trunk receives `+15551234567`. The same user
  sets follow-me to `5551234567`; the compiled hop carries `dialedNumber: "5551234567"` and the carrier
  rejects the INVITE. The failure is silent at compile time (a warning is only emitted when the hop matches
  _no_ route) and shows up as "follow-me just doesn't work" for the one tenant who uses translations.
- Fix: apply the ruleset in `followMeTrunkTarget` the same way. The compiler already has `rule.translation`
  on the `OutboundRule` in hand; `applyTranslationRuleset` is pure and clock-free, so it is compile-safe:
  ```ts
  const outcome =
  	rule.translation === undefined
  		? undefined
  		: applyTranslationRuleset(rule.translation, dialedNumber);
  const finalNumber = outcome === undefined || outcome.overflowed ? dialedNumber : outcome.value;
  ```
  and extend the doc comment at `compile.ts:1193-1201`, which currently enumerates what is shared and does
  not mention translations either way.
- Cross-area: none.

### [P1] Inbound caller-id rulesets can emit characters the "dialable output" guarantee forbids (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/translations.ts:104-118`
  and `resolve.ts:486-519`
- Code:
  ```ts
  const BACK_REFERENCE_PATTERN = /\$(?:[1-9]|\$)/gu;
  export function isSafeReplacement(replacement: string): boolean {
  	return REPLACEMENT_LITERAL_PATTERN.test(replacement.replaceAll(BACK_REFERENCE_PATTERN, ""));
  }
  ```
- Problem: the safety argument (`translations.ts:108-112`) is _"what `$1` expands to is bounded by the INPUT
  rather than by this string — and the input is a dial string, which the caller already dialed."_ That
  premise holds for `applyRouteTranslation` (outbound, digits a local extension pressed). It does **not**
  hold for `normaliseInboundCaller`, which runs the same rulesets over `input.callerNumber` — a value
  supplied by the carrier and ultimately by the calling party. A ruleset with `^(.*)$` → `$1` (a plausible
  no-op or a `^\+?(.*)$` normaliser) passes validation and passes the caller id through verbatim, `@` and
  `;` included, into `ResolvedRoute.callerIdNumber`.
  Separately, `$$` survives the strip and `String.replace` renders it as a literal `$`, so a replacement of
  `$$1` passes `isSafeReplacement` and emits `$1` literally.
- Failure scenario: a caller id of `1234@attacker.example;transport=tcp` is normalised, screened against the
  blocklist as a whole string (so it evades a prefix block on `1234`), and handed to the engine as the
  caller id to present onward.
- Fix: sanitise the _output_ of `applyTranslationRuleset`, not only the replacement literal — reject/refuse
  the rewrite when the result does not match `/^[0-9+*#]*$/` (the same alphabet `PREPEND_PATTERN` enforces),
  returning the input unchanged with an `overflowed`-style flag. That closes both the back-reference hole
  and the `$$` case in one place, and costs one regex test per rewrite.
- Cross-area: none — but the same argument applies wherever else carrier-supplied strings reach a ruleset.

### [P1] Tenant-authored regexes run per-call against carrier-supplied input with no ReDoS bound (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/patterns.ts:97-105`,
  `translations.ts:88-102`
- Code: `void new RegExp(source); return null;` — compilability is the only check.
- Problem: `MAX_PATTERN_LENGTH` (256) bounds the pattern's _length_, not its backtracking behaviour. A
  256-character pattern is more than enough for `^(a+)+$`. These regexes are evaluated on the inbound call
  path against attacker-influenced values: `InboundRule.callerPattern` and every `CompiledCallBlockRule`
  pattern are matched against `input.callerNumber` (`resolve.ts:387,536`).
- Failure scenario: a tenant (or a compromised admin session) saves a call-block rule with a catastrophic
  pattern. Every inbound call from a carrier then spends seconds in `matchPattern` on the engine's event
  loop; a handful of concurrent calls stalls routing for the whole process. Node has no regex timeout, so
  there is no runtime recovery.
- Fix: at minimum, a compile-time heuristic rejecting nested unbounded quantifiers (`(x+)+`, `(x*)*`,
  `(x|x)*`) with an `invalid-regex` diagnostic; better, run the match through a linear-time engine
  (`RE2`-style) for the patterns that see untrusted input. Both are behind the existing `compilePattern`
  seam, so the change is contained.
- Cross-area: `MAX_PATTERN_LENGTH` is a documented public constant; adding a rejection rule changes what the
  API's save path accepts (a new error diagnostic, not a schema change).

### [P1] Every resolve allocates and formats diagnostics that are almost always discarded (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/resolve.ts:221-225,
266-271, 289-294, 354-359, 463-467, 719-723`
- Code:
  ```ts
  diagnostics.push({ severity: "info", code: "time-condition-open",
      message: timeConditionMessage(condition.name, condition.timezone, evaluation), … });
  ```
- Problem: these are unconditional. A resolve that crosses two gates and matches a rule builds three
  diagnostic objects, two `DiagnosticSubject` objects and three multi-interpolation template strings
  (`resolve.ts:322-332` formats a zoned clock string every time). This is the per-call hot path, and the
  strings exist to answer a support question that is asked about a tiny fraction of calls.
- Failure scenario / cost: at a few thousand calls/second the string formatting and object churn is pure
  GC pressure on the engine's event loop, for output nobody reads. It also inflates every
  `ResolvedRoute` crossing the rpc boundary.
- Fix: add an `explain?: boolean` to the three `Resolve*Input` types (default false) and gate the `info`
  diagnostics on it; keep `warning` diagnostics unconditional. Callers that want the "why did this call go
  there" trace opt in.
- Cross-area: the rpc contract's `reason` field is already built unconditionally and is cheap; only the
  `diagnostics` array would become conditional, so any consumer reading `diagnostics` for `info` entries
  would need the flag.

### [P2] `compileVoicemailPrefixes` reports feature-code clashes that cannot happen (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/compile.ts:2953-2957`
- Code:
  ```ts
  const clash = featureCodes.find(
  	(code) => code.code === entry.prefix || entry.prefix.startsWith(code.code),
  );
  ```
- Problem: this is the third copy of the "would a feature code swallow this string?" test, and the only one
  that omits the `argumentMode` guard. `compileSpeedDials` (`compile.ts:2277-2281`) and
  `reportToggleCodeCollisions` (`compile.ts:3247-3250`) both write
  `code.code === value || (code.argumentMode !== "none" && value.startsWith(code.code))` — matching
  `matchFeatureCode`, which only consumes a prefix when `argumentMode !== "none"` (`feature-codes.ts:196-199`).
- Failure scenario: a tenant with the seeded `*9` (or any no-argument code) and a voicemail prefix of `*99`
  gets a permanent `conflicting-feature-code` warning saying "the feature code wins", when in fact `*99200`
  routes to voicemail correctly. Warnings that are wrong teach tenants to ignore warnings — which the
  header of `patterns.ts` explicitly names as the thing to avoid.
- Fix: extract the shared predicate (`featureCodeWouldConsume(codes, value)`) into `feature-codes.ts` next
  to `matchFeatureCode`, so the check and the matcher cannot drift, and use it at all three sites.
- Cross-area: none.

### [P2] An invalid queue exit key vanishes with no diagnostic (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/compile.ts:4297-4303`
  (`normalizeExitKey`), used at `compile.ts:1522`
- Code: `return (QUEUE_EXIT_KEYS as readonly string[]).includes(trimmed) ? trimmed : undefined;`
- Problem: the doc above it says a bad value is _"rejected outright"_ because _"anything that would never
  match must not reach [the engine] wearing the costume of a configured feature"_ — but it is rejected
  silently. `queueNode` only warns when `exitKey !== undefined && exitNodeId === undefined`, so a queue
  configured with exit key `Z` (or a value a loader mangled) compiles to a queue with no exit key at all and
  no diagnostic explaining why the tenant's configured digit does nothing.
- Fix: have `normalizeExitKey` return the rejected raw value to the caller (or take the bag) so
  `queueNode` can raise a `warning` naming the value and the allowed set.
- Cross-area: none.

### [P2] `reportInboundShadowing` allocates a fresh prefix array on every iteration (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/compile.ts:3426-3428`
- Code: `for (const earlier of rules.slice(0, index)) {`
- Problem: the comparison is inherently O(n²), but `slice` makes it O(n²) _copies_ on top — for n inbound
  routes it allocates n arrays totalling n²/2 elements. A tenant with 500 DIDs pays ~125k pointer copies and
  500 array allocations on every compile, including every compile-on-save.
- Fix: `for (let i = 0; i < index; i += 1) { const earlier = rules[i] as InboundRule; … }`. Same behaviour,
  no allocation.
- Cross-area: none.

### [P2] `translationRuleset` does a linear scan of the ruleset collection on every reference (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/compile.ts:1774-1776`
- Code: `const input = (this.snapshot.translationRulesets ?? []).find((entry) => entry.id === id);`
- Problem: the compiler already builds `translationRulesetsById`, but that map holds the _compiled_ form and
  carries no `enabled` flag, so the enabled check falls back to a scan of the raw collection. Called once per
  outbound route and once per trunk, so O(routes × rulesets).
- Fix: index the raw inputs too (`translationRulesetInputsById`), the same way `timeConditionInputsById` sits
  beside `timeConditionsById` for exactly this reason.
- Cross-area: none.

### [P2] Two artifact fields are structurally always `true` (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/compile.ts:3411`
  (`enabled: did.enabled`) and `compile.ts:4033` (`enabled: extension.enabled`)
- Problem: both loops `continue` on a disabled row three lines earlier (`compile.ts:3392`, `compile.ts:4026`),
  so `InboundDidDefault.enabled` and `ExtensionIndexEntry.enabled` are `true` in every artifact ever
  produced. Neither is read anywhere in `resolve.ts` — `resolveInbound` uses `didDefaults[did]` without
  consulting `enabled` (`resolve.ts:444-445`), which is _correct_ given the compiler's filtering but reads
  like a missing guard to anyone auditing the resolver.
- Fix: drop both fields (they are not load-bearing and their absence is an old-reader-safe change under the
  package's own versioning rule), or leave them and add a one-line comment at each read site saying the
  filtering happens at compile time.
- Cross-area: dropping `ExtensionIndexEntry.enabled` touches any API/engine consumer that reads it — grep
  before removing.

### [P2] Over-long `settings.emergencyNumbers` silently drops valid entries (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/routing/src/emergency.ts:100`
- Code: `for (const raw of (configured ?? []).slice(0, MAX_EMERGENCY_NUMBERS)) {`
- Problem: the cap is applied _before_ validation, and `invalidEmergencyNumbers` (which feeds the compiler's
  diagnostic) scans the whole list without the cap. So entries 33+ that are perfectly valid are dropped with
  no diagnostic, while malformed entries beyond the cap are warned about despite never being considered.
- Failure scenario: a multinational tenant lists 40 emergency numbers; the last eight are silently not
  dialable, in the one subsystem where a silent drop is a compliance question.
- Fix: filter first, then cap, and raise a `warning` naming the entries the cap discarded.
- Cross-area: none.

### Verified and dropped

- `sha256.ts` implements FIPS 180-4 correctly; `padded()`'s block count is exact at the 55/56-byte boundary.
  The `code = 0` assignment at `sha256.ts:164` is dead but harmless.
- `canonical-json.ts` is sound: prototype check, `-0` normalisation, `undefined` dropped in objects and
  rendered as `null` in arrays, non-finite numbers throw.
- Emergency ordering is correct in both resolvers — the table is consulted before the kill switch, the caller
  lookup, the toll-class gate and `callBlock` in `resolveOutbound` (`resolve.ts:756-758`) and before
  `callBlock` and the feature codes in `resolveInternal` (`resolve.ts:602-605`).
- `resolveOutbound`'s `caller?.tollClass ?? input.tollClass` matches its documented "an extension cannot
  escape its own class" rule; the override only applies to non-extensions.
- Dial-plan matching is **not** O(n) per digit: inbound/outbound walk pre-sorted rule lists once, feature
  codes are a length-sorted linear walk, internal numbers/mailboxes/speed dials are record lookups. The only
  linear scans are `parkSlots` (bounded by lot count) and `callBlock` (bounded by rule count). The design
  claim in `patterns.ts`'s header holds.
- No exported API in the package is typed `any`, and there are no unsafe casts beyond the contained
  `namedDestinationNode` index-access cast, which re-validates through `destinationNode`.
- `voicemail-pin.ts` bounds cost/blockSize/parallelism _and_ the derived `128·N·r·p` working set, and
  validates base64 length exactly. Sound.
- `Artifact.diagnostics` is unbounded and rides in the KV cache; noted but not filed — a pathological tenant
  is the only way to make it large, and every diagnostic is individually justified.

---

## packages/telnyx

### [P0] Response body read sits outside the retry `try` — a mid-body failure escapes as a raw error (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/telnyx/src/transport.ts:231`
- Code: `const text = await response.text();`
- Problem: only `doFetch(...)` is wrapped. `fetch` resolves on headers; the body streams afterwards under
  the same `AbortSignal.timeout(timeoutMs)`. A per-attempt timeout firing mid-body, or a socket reset,
  rejects here.
- Failure scenario: a truncated 200 on `GET /phone_numbers` throws a raw `AbortError`/`TypeError` out of
  `request()` — not a `TelnyxTransportError`, not retried, not reported to `onAttempt`. The API's carrier
  layer catches only the two typed errors, so this surfaces as a 500 with a carrier-shaped stack.
- Fix: move `response.text()` inside the same `try`, treating a rejection exactly as a fetch rejection
  (record `lastTransportCause`, emit `onAttempt`, retry per policy).
- Cross-area: also under-reports in the "did not complete after N attempts" accounting.

### [P0] `Retry-After` is trusted without an upper bound (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/telnyx/src/retry.ts:92-112`,
  consumed at `transport.ts:271-275` and `retry.ts:82`
- Code: `return (retryAfterMs ?? 0) + jittered;`
- Problem: `parseRateLimitResetMs` rejects implausible values (`MAX_PLAUSIBLE_RESET_SECONDS = 3_600`);
  `parseRetryAfterMs` has no equivalent clamp for either delta-seconds or a far-future HTTP-date — and it is
  checked _first_, so it wins over the guarded header.
- Failure scenario: a proxy/WAF in front of Telnyx answers 503 with `Retry-After: 86400`. The transport
  `await wait(86_400_000)` up to three times. `timeoutMs` does not cover the sleep, so a NestJS handler and
  its DB transaction are pinned for a day per attempt. There is no cumulative retry budget anywhere.
- Fix: `Math.min(parsed, policy.maxRetryAfterMs ?? 60_000)`, plus a total retry deadline checked before each
  `wait`.
- Cross-area: same code path as the rate-limit handling, which already has the guard this one lacks.

### [P1] 5xx retries on connection/profile creation create orphans, not idempotent repeats (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/telnyx/src/resources/credential-connections.ts:275-284`,
  `.../outbound-voice-profiles.ts:142-148`
- Code: `// Creating a connection is cheap and non-billable, and a duplicate is detectable and deletable`
- Problem: the reasoning covers cost, not outcome. Telnyx enforces `user_name` uniqueness (the fake models it,
  `fake/server.ts:468-475`). A 500 _after_ the connection was created means the retry gets a non-retryable
  `422 user_name is already taken` — the caller sees a hard failure while a real connection exists at the
  carrier holding the only username the provisioner will generate for that org. Profiles have no uniqueness
  at all, so the same sequence silently leaves duplicate outbound voice profiles, each carrying a
  `daily_spend_limit`, with no reconciliation read.
- Fix: `retryable: false` plus a `findByUserName`/`findByName` reconciliation read, or have `create` treat a
  retry's "already taken" 422 as a signal to fetch the existing record.
- Cross-area: `NumberOrdersResource.findByCustomerReference` is the pattern to copy; neither resource has an
  equivalent lookup today.

### [P1] List endpoints silently truncate — no pagination, page metadata discarded (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/telnyx/src/resources/phone-numbers.ts:187-202`,
  `outbound-voice-profiles.ts:182-193`, `number-orders.ts:149-157`
- Code: `return response.data;` (each drops the parsed `meta`)
- Problem: `phoneNumbers.list()` sends no `page[size]` unless the caller supplies one, so it returns Telnyx's
  default first page (20) with nothing telling the caller there are more. `outboundVoiceProfiles.list` pins
  50; `findByCustomerReference` pins 20. `listEnvelope` already parses `meta.total_pages` /
  `total_results` — and all three throw it away.
- Failure scenario: an account with >20 numbers. `resolveCarrierNumberId` filters by a single E.164 so it is
  safe today, but any admin-facing "list our DIDs" caller gets a silently short list with no way to detect it.
- Fix: return `{ data, meta }` (or expose an async-iterator `listAll`) so callers opt into truncation rather
  than inherit it.

### [P2] `findByCustomerReference` promises an ordering the API does not guarantee (confidence: medium)

- Where: `.../resources/number-orders.ts:108-113`, caller at
  `apps/api/src/pbx/carrier/carrier.service.ts:356-357` (`return orders[0];`)
- Problem: no `sort` parameter is sent and the endpoint's default ordering is not pinned in
  `reference/telnyx-api.md`. The fake returns Map-insertion order, so the single-order spec cannot catch a
  mismatch. Reconciliation after an ambiguous order failure is exactly where picking the wrong record matters.
- Fix: send an explicit sort and pin it, or sort by `created_at` in the resource — and drop the "newest
  first" claim from the doc otherwise.

### [P2] `decodeBase64` does not do what its comment claims (confidence: high)

- Where: `.../webhooks/signature.ts:57-72`
- Code: doc says _"Decodes strict base64, rejecting anything that is not"_; body is
  `Buffer.from(value, "base64")` plus a length check.
- Problem: `Buffer.from` ignores junk characters, so a signature with embedded garbage that decodes to 64
  bytes reaches `verify` and is reported as `mismatch` — the confusion the comment says it prevents. Not
  exploitable (Ed25519 is still the gate) but it will mislead the next person hardening this.
- Fix: validate against `/^[A-Za-z0-9+/]+={0,2}$/` and re-encode-compare, or reword the comment.

### [P2] Snake-case body assembly is reimplemented five times in two styles (confidence: high)

- Where: `phone-numbers.ts:217-319` (nested spread-ternary, ~100 lines) vs
  `credential-connections.ts:201-253` and `outbound-voice-profiles.ts:91-121` (imperative `if (x !== undefined)`)
- Problem: `updateVoiceSettings` is a 70-line spread pyramid that a small `omitUndefined({...})` helper
  collapses to a dozen lines. Two idioms for one job across sibling files makes a missed field invisible in
  review.
- Fix: one shared `compact()` in `schemas.ts`, used by every resource body builder.

### Verified and dropped

- Webhook verification is correct: Ed25519 pure mode, `null` algorithm, no string comparison of secrets,
  two-sided ±300s window with tests on both edges. No timing-unsafe compare anywhere.
- The API key never reaches a log line, error message, or thrown object in production code (`onAttempt` logs
  method/path/attempt/status only).
- `retryable: false` on `POST /number_orders` and `POST /faxes` is correct and deliberate.
- No exported production API is typed `any`; `JSON.parse` of error bodies is total.

---

## packages/media-ari

### [P0] The open-timeout path abandons the WebSocket without closing it (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/media-ari/src/event-stream.ts:182-185,
266-278, 317-322`
- Code: `this.openTimer = setTimeout(() => { settleErr(…); this.teardownAndScheduleReconnect(socket); }, …)`
  → `private detach(socket) { socket.onopen = null; … }`
- Problem: `teardownAndScheduleReconnect` only _detaches_ handlers; it never calls `socket.close()`. On the
  `onclose` path that is right (the socket is dead). On the open-timeout path the socket is still
  `CONNECTING`/`OPEN`.
- Failure scenario: Asterisk accepts the TCP/TLS connection but stalls the upgrade (overloaded box, half-open
  NAT path). Every 10s the stream gives up, leaves a live un-GC-able socket holding an fd and a TCP
  connection, and opens another — one orphaned socket per attempt, forever. fd exhaustion in the engine, and
  a pile of half-open connections on a media server that is already struggling.
- Fix: after `detach`, `try { socket.close(NORMAL_CLOSURE, "…"); } catch {}`. `close()` at `:139-153` is the
  model.
- Cross-area: `event-stream.spec.ts` never exercises the open-timeout branch; `FakeSocket.close` already
  records `closedWith`, so a one-line assertion would have caught it.

### [P0] A failed `start()` leaves a live reconnect loop the caller cannot stop (confidence: high)

- Where: `.../event-stream.ts:129-136`
- Code: `this.stopped = false; this.attempts = 0; await this.connect();`
- Problem: when the first connection fails, `connect()` rejects — but `onclose`/the open timer have already
  run `teardownAndScheduleReconnect`, which sets status `reconnecting` and schedules a retry. `start()`
  throws while the object keeps retrying, and `stopped` stays `false`, so a second `start()` returns
  immediately (`:130-132`) without connecting.
- Failure scenario: `apps/engine/src/media/ari-connection.service.ts:148` awaits `stream.start()` in a
  "fail fast at boot" path. On a bad password, boot throws — and the process either exits with a pending
  retry or survives with a socket that later opens and delivers events to a half-constructed service. The
  rejection test at `spec:158-167` has to call `close()` by hand, which is the same symptom.
- Fix: on rejection, `this.close()` (or at minimum `this.stopped = true; this.clearTimers()`) before
  rethrowing, so a failed `start()` leaves the stream `closed` and restartable.

### [P1] The 10s request timeout does not cover the response body (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/media-ari/src/http-client.ts:88-115`
- Code: `} finally { clearTimeout(timer); }` … then `const text = await response.text();`
- Problem: the `AbortController` timer is cleared when `fetch` resolves — i.e. when _headers_ arrive.
  `await response.text()` then has no timeout and no abort signal.
- Failure scenario: Asterisk sends `200 OK` + headers and stalls the body (a large `GET /channels` on a
  loaded box, or a stalled TCP window). The call hangs indefinitely; because the engine awaits these inside
  call control (`channels.answer`, `bridges.addChannels`), one stalled body wedges a call leg with no
  timeout and no error — precisely what the 10s budget exists to prevent.
- Fix: clear the timer in a `finally` wrapping both the fetch and the body read, and wrap `response.text()`
  in the same `try` so an abort maps to `AriTransportError` rather than escaping as a raw `DOMException`.

### [P1] An aborted request is reported as an unreachable server, losing the timeout signal (confidence: high)

- Where: `.../http-client.ts:105-107`, `.../errors.ts:79-88`
- Code: `catch (cause) { throw new AriTransportError(input.method, input.path, { cause }); }`
- Problem: DNS failure, connection refused, TLS failure and our own 10s timeout all collapse into one error
  reading "could not reach Asterisk", distinguishable only by `cause.name === "AbortError"` — which nothing
  checks. `AriHttpError` got a first-class `status`/`isRetryable` for exactly this reason; the transport
  error did not.
- Failure scenario: retry policy above this seam cannot distinguish "never connected" (safe to retry an
  originate) from "timed out mid-request" (retrying may place a duplicate call) — the hazard `isRetryable`
  is documented to avoid at `errors.ts:68-75`.
- Fix: add `timedOut: boolean` (or a `kind`) to `AriTransportError`, set from `controller.signal.aborted`.

### [P2] No cap on reconnect attempts, and nothing surfaces "this will never recover" (confidence: medium)

- Where: `.../event-stream.ts:280-299, 301-315`
- Code: `this.attempts += 1; const delay = computeBackoffDelayMs(this.attempts, …)`
- Problem: `attempts` is unbounded and `BackoffOptions` has no `maxAttempts`. The delay cap at 30s means
  there is no storm, and the `Infinity` case degrades gracefully — the gap is policy: a permanently-wrong
  credential retries every ~15-30s forever with only `onError` logs, and `isOpen` just stays false.
- Fix: optional `maxAttempts`; on exhaustion set status `closed` and report a terminal `AriSocketError` so
  `/healthz` can fail hard. Filed P2 rather than P1 because infinite retry is defensible for telephony — it
  should be a stated choice, not an absent one.

### [P2] `channelOfEvent` returns the _peer_ for `Dial`, the wrong leg for A-leg demux (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/media-ari/src/events.ts:323-324`
- Code: `case "Dial": return event.peer;`
- Problem: every other case returns the channel that _changed_. For `Dial`, `peer` is the B-leg and `caller`
  is the A-leg that initiated it. A consumer using this as a routing key files `Dial` under the B-leg, so a
  per-call state machine keyed on the A-leg never sees the `dialstatus` (`BUSY`/`NOANSWER`/`CHANUNAVAIL`)
  that outbound failover keys off — documented as the point of the event at `events.ts:233-236`.
- Fix: document the choice in the JSDoc (currently silent) or expose both (`{ channel, peer }`). Exported
  from `index.ts:33` with no in-repo caller yet, so fixing now costs nothing.

### [P2] `encodeSegment` is the documented path-escaping seam and nothing uses it (confidence: high)

- Where: `.../url.ts:51-54` vs. all six resource files (e.g. `channels.ts:104` inlines `encodeURIComponent`)
- Problem: 40+ inlined calls duplicate the abstraction built to centralise them (its doc explains the
  Local-channel `;` case). Escaping is currently correct everywhere, so this is not a live injection hole —
  but the seam has no callers, so the next path that forgets it has nothing to catch it.
- Fix: use `encodeSegment` everywhere, or delete the export. Keeping both is the worst option.

### Verified and dropped

- `buildQuery` / `buildEventsUrl` / `redactAriUrl` are sound: `URLSearchParams` encoding, `undefined`
  dropped, arrays repeated, `api_key` and userinfo both redacted, `https:`→`wss:` correct,
  `normalizeAriBaseUrl` handles the duplicate-`/ari` case it claims to.
- Event demux has no misrouting beyond the `Dial` note; no shared mutable listener map that could grow.
- JSON parse failures cannot crash the process — `parseAriEventFrame` throws, `handleMessage` catches both
  the parse and the user handler, `reportError` swallows a throwing error handler, `scheduleReconnect`
  attaches `.catch`. No unhandled-rejection path found.
- No exported API typed `any`; the two `as z.infer<TSchema>` casts follow a successful `safeParse`.
- `close()` clears both timers, detaches, is idempotent; `reconnectTimer.unref?.()` keeps the retry from
  holding the process open.

---

## packages/telephony

### [P1] A complete feature code is silently lost when the next digit doesn't extend it (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/packages/telephony/src/mid-call-features.ts:478-503`
- Code: `if (exact !== undefined || extendable) { return this.arm("captured", nowMs + this.settings.codeTimeoutMs); } return this.abandon();`
- Problem: `resolveCode` keeps only the _current_ accumulated string. With both `*1` and `*12` in the table,
  pressing `*1` arms (exact but extendable). A third digit matching nothing (`*13`) falls to `abandon()` —
  the already-matched, complete `*1` is discarded. The three-case doc at `:336-343` has no case for "an
  earlier exact match existed".
- Failure scenario: the user presses `*1` (record-toggle) then `3` for the far-end IVR. Neither happens —
  recording never starts, and `3` comes back only as an `abandoned.swallowed` blob the engine must decide how
  to replay.
- Fix: latch the last exact match in `resolveCode`; on the non-matching digit, fire the latched entry and
  return the trailing digits as pass-through rather than abandoning everything.
- Cross-area: same shape as the dial-time longest-match in `packages/routing/src/patterns.ts`, but
  `patternSpecificity` resolves ties over a complete input, so routing has no equivalent hole.

### [P1] `executing` has no watchdog: one lost `settle()` swallows DTMF for the rest of the call (confidence: high)

- Where: `.../mid-call-features.ts:524-541` and `:380-399`
- Code: `this.current = "executing"; this.deadlineMs = undefined;` … `case "executing": return this.step("captured");`
- Problem: `executing` is only left via `settle()` or `cancel()`. `beginExecuting` clears the deadline and
  returns a step with no `wakeAtMs`, so the engine cancels its timer — directly contradicting the
  `MidCallFeatureStep.wakeAtMs` contract at `:284-286` ("Present on EVERY step that leaves the machine
  mid-capture"). `mid-call-features.spec.ts:226-229` pins the no-timer behaviour.
- Failure scenario: a blind transfer whose routing walk throws, or an engine fiber killed between `execute`
  and `settle`, leaves the machine in `executing` permanently. Every subsequent digit from that party is
  captured and never reaches the far end — the caller cannot use the remote IVR, with no error anywhere.
- Fix: emit an `executionTimeoutMs` deadline on the `execute` step and have `expire` force a return to `idle`
  (kind `abandoned`) when it elapses.

### [P1] `verbRequiresMediaPath` admits `hold`/`park` on an early-media leg the call-state machine then rejects (confidence: high)

- Where: `.../verbs.ts:524-539`, `channel.ts:153-155`, `call-state.ts:61-71`
- Code: `return hasChannelFlag(channel, "answered") || hasChannelFlag(channel, "early-media");` /
  `active: ["held", "hangup"],`
- Problem: `hold`, `unhold`, `park`, `unpark` sit in `MEDIA_PATH_VERBS` gated on `hasMediaPath`, which is
  true for a 183 early-media leg that was never answered — the comment at `:534-536` states the opposite
  intent. Two guards then disagree: the verb guard passes, the leg's call state is `early`, and `early` has
  no edge to `held`, so `assertCallStateTransition("early","held")` throws
  `InvalidCallStateTransitionError` — which `errors.ts:24-29` says is "always a bug in the engine, never
  user input" and must not become a 4xx.
- Failure scenario: an app sends `hold` during a pre-answer announcement; the verb is accepted and the
  engine then raises an internal invariant error mid-call instead of cleanly rejecting the request.
- Fix: gate hold/park on the `answered` flag specifically (a second predicate, `verbRequiresAnswer`), not on
  `hasMediaPath`.

### [P2] `channel.hangup` is the milestone for two independently-advancing machines (confidence: high)

- Where: `.../events.ts:297-311`
- Code: `CHANNEL_STATE_MILESTONE_EVENTS = { … hangup: "channel.hangup" }` /
  `CALL_STATE_MILESTONE_EVENTS = { … hangup: "channel.hangup" }`
- Problem: `channel-state.ts:9-11` states explicitly that the two machines "advance independently". Both
  reaching `hangup` maps to the same event name, and neither the maps nor the specs define which is
  authoritative or how to dedupe.
- Failure scenario: an engine driving both tables emits `channel.hangup` twice per leg. `packages/cdr-db`
  replays the stream to rebuild a CDR, so the leg gets two hangup facts — or two _different_ causes if the
  machines are torn down at different instants.
- Fix: name the call-state milestone distinctly (or drop `hangup` from one map) and pin uniqueness of the
  milestone values in `events.spec.ts`.
- Cross-area: `packages/cdr-db` consumes these.

### [P2] The park timeout has no legal edge during a retrieval (confidence: medium)

- Where: `.../park.ts:82-90`
- Code: `parked: ["retrieving", "timed-out", "abandoned"], retrieving: ["retrieved", "parked", "abandoned", "failed"],`
- Problem: `timed-out` is reachable only from `parked` (pinned by `park.spec.ts:84-89`), but the lot timer
  armed while `parked` can fire while the call is in `retrieving` — and `retrieving → parked` is an
  explicit, expected fallback (`:78`).
- Failure scenario: the lot timeout fires during a failed retrieval. The engine either throws on
  `assertParkTransition("retrieving","timed-out")` for a perfectly normal race, or swallows the timer — and
  if the retrieval then falls back to `parked`, the call sits in the orbit with no timeout armed and is never
  returned to the parker.
- Fix: allow `retrieving → timed-out`, or make it contractual that re-entering `parked` re-arms the timeout,
  and pin it.

### [P2] `DeviceStateChangedEvent` is the only union member that is not a `CallEventBase` (confidence: high)

- Where: `.../events.ts:237-250`
- Code: `export type DeviceStateChangedEvent = { readonly event: "device.state-changed"; readonly organizationId: string; …`
- Problem: its own doc says it "carries no `channelId` correlation of its own **beyond the base**", but it
  does not intersect `CallEventBase` at all — no `callId`, no `channelId`. `CallEvent` therefore has no
  common correlation field, so a consumer partitioning or routing the stream by `callId` must special-case
  this one member (`events.spec.ts:75-107` demonstrates the special case rather than flagging it).
- Fix: either make it `CallEventBase &` with a documented sentinel, or split it out of `CallEvent` so the
  base guarantee holds for what remains.

### [P2] Caller identity is unstructured `string`, with no representation for anonymous/withheld (confidence: medium)

- Where: `.../channel.ts:78-96`, `verbs.ts:143-147`
- Code: `readonly callerIdNumber?: string;` / `export type CallerIdOverride = { readonly name?: string; readonly number?: string; };`
- Problem: absent, `""`, `"anonymous"`, and a SIP `Privacy: id` withheld caller all collapse into one
  optional string, in the package that claims to own "the invariants of a phone call". There is also no
  E.164 validator on `DialTarget.destination` or `CallerIdOverride.number` — the `external` kind is
  _documented_ as E.164 at `verbs.ts:129` and unchecked.
- Failure scenario: a CDR writer and a BLF publisher reading the same snapshot disagree on whether a call
  was anonymous; an `external` dial target carrying a national-format number reaches a trunk unvalidated.
- Fix: model presentation explicitly (`callerIdPresentation: "allowed" | "restricted" | "unavailable"`) and
  add a shared E.164 predicate.

### Verified and dropped

- **No E.164 duplication across packages.** `packages/telephony` contains no phone-number parsing,
  formatting or normalization at all — no `+` handling, no country-code assumption, no N11 or
  international-prefix stripping. The only normalization in the area is trunk-ruleset-driven
  (`routing/src/resolve.ts:486-518`) plus digit strip/prepend (`routing/src/patterns.ts:250-282`). Nothing
  duplicates `patterns.ts` or `destinations.ts`; the extension-vs-external decision lives entirely in
  `DialTargetKind`/`DestinationType`.
- **No `any` in the public surface.** Zero `: any` / `as any` / `<any>` across all 15 source files; the two
  casts in `hangup-causes.ts:176-179` are a sound `Object.fromEntries` narrowing.
- **DTMF parsing is sound.** `parseDtmfDigits` iterates by code point, rejects the whole string on any
  non-symbol, up-cases `a`-`d`; `""` → `[]` is documented and tested. The A-D set is complete.
- **Hangup codes match the frozen reference verbatim** (`plans/reference/freeswitch-capabilities.md:47`),
  including the non-FreeSWITCH-native `LOSE_RACE(702)` and `800`-series values; code↔name is bijective and
  round-trip tested.

---

## Cross-area notes

- **Duplicated "would a feature code consume this?" predicate** — three copies inside `routing/src/compile.ts`
  (2277, 2953, 3247), one of which is wrong. Fix belongs in `routing/src/feature-codes.ts`. No file outside
  the area.
- **Body-read-outside-the-timeout is the same bug in two packages** — `telnyx/src/transport.ts:231` and
  `media-ari/src/http-client.ts:88-115`. Independent codebases, identical mistake; fixing one is the template
  for the other.
- **`packages/routing` `ExtensionIndexEntry.enabled`** is read by the API's credential responder path; check
  `apps/api/src/pbx/sip-credentials/` before removing it (P2 above).
- **`packages/telephony` milestone-event names** are consumed by `packages/cdr-db`; the `channel.hangup`
  collision fix is a contract change there.
- No finding requires a database migration or a `pbx-db` schema change.
