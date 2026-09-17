/**
 * The auto-answer signal, as the ENGINE puts it on the wire.
 *
 * ## What this is
 *
 * Intercom (`*80`) and paging (`*81`) are the only two features in the system whose whole point is
 * that the far handset picks up by itself. Nothing in SIP makes a phone do that; what makes it do
 * that is a header the phone was configured to recognise. So the engine sends the header and the
 * provisioning templates configure the phones to honour it, and the two have to agree on a literal
 * string or the feature silently degrades to "everybody's phone rings" — which is not an error
 * anywhere, just forty handsets chirping while somebody talks into a dead page.
 *
 * `apps/api/src/provisioning/auto-answer.ts` owns the same two literals for the phone side and
 * explains the vendor survey behind them at length. **These constants are that file's values,
 * verbatim, and must stay that way.** They are duplicated rather than imported because `apps/engine`
 * does not depend on `apps/api` and must not start to for two strings; the alternative — moving them
 * into a shared package — would put a provisioning detail into `packages/telephony`, which every
 * other application would then carry for one feature neither of them uses. The duplication is
 * therefore deliberate, it is named on both sides, and the honest statement of the risk is: if one
 * side is edited without the other, paging stops auto-answering and no test in either repo half
 * fails. A parity spec across the two apps would be the fix, and there is no harness for one today.
 *
 * ## Why BOTH headers, every time
 *
 * The five vendor templates in `apps/api/src/provisioning/catalog/templates/` do not agree on which
 * header carries the instruction, and the split is a header difference rather than a token
 * difference — so no single choice reaches all five. Checked, one by one:
 *
 * - **Yealink** (`yealink.ts`) — matches `Alert-Info` against `info=alert-autoanswer`. Its template
 *   already interpolates `AUTO_ANSWER_ALERT_INFO` into the `.cfg` it writes.
 * - **Poly** (`poly.ts`) — matches `Alert-Info` against a string the ADMINISTRATOR chooses
 *   (`voIpProt.SIP.alertInfo.1.value`), and its template points that setting at the same token.
 * - **Snom** (`snom.ts`) — matches the `info=` parameter of `Alert-Info`; its own documentation
 *   shows the token hanging off a decorative URI, and matches on the parameter either way.
 * - **Fanvil** (`fanvil.ts`) — has an intercom feature with no documentation we could read about
 *   what triggers it from the wire. It gets both headers and may honour neither; that is stated
 *   rather than guessed at, exactly as its template states its unverified key encodings.
 * - **Grandstream** (`grandstream.ts`) — does NOT read `Alert-Info` at all. Its setting is "Allow
 *   Auto Answer by Call-Info" and what it looks for is `answer-after=` on a `Call-Info` header, the
 *   Broadsoft convention rather than the Yealink/Snom one.
 *
 * Three of five on `Alert-Info`, one configurable onto it, one that needs `Call-Info`. Sending both
 * costs nothing on the wire — a phone ignores the header it was not configured for — and it is the
 * only arrangement that pages all five vendors from one origination.
 *
 * ## How the engine actually sets a SIP header
 *
 * Through channel VARIABLES, which is the one part of this that looks wrong until you know why.
 * `MediaPort.originate` carries `variables`, and ARI's originate applies them to the new channel
 * BEFORE the INVITE is composed. Asterisk exposes header manipulation as a dialplan FUNCTION —
 * `PJSIP_HEADER(add,<name>)` — and a function assignment is spelled exactly like a variable
 * assignment, so setting the "variable" `PJSIP_HEADER(add,Alert-Info)` is how a header is added.
 * There is no other seam: ARI's originate has no header parameter, and `apps/asterisk`'s dialplan
 * only ever READS `PJSIP_HEADER` today (see `config/extensions.conf`).
 *
 * That is Asterisk vocabulary above the media seam, and it is here rather than in
 * `ari-media.adapter.ts` for the reason `media-refs.ts` gives for the mirror-image case: WHICH
 * headers a feature sends is a product decision about handsets, and HOW a driver puts a header on an
 * INVITE is a protocol detail. A driver that cannot add headers ignores these variables and the page
 * rings normally, which is the safe half of the failure.
 *
 * ## What this is NOT
 *
 * Not a security boundary. A header is a REQUEST to the handset, honoured because the handset was
 * configured to honour it, and anything that can reach the SIP edge can send one. What stops a
 * stranger opening a microphone in somebody's office is that the INVITE has to authenticate and
 * route first — the same gate every other call goes through. Use it on intercom and paging
 * originations and nowhere else: an auto-answer header on an ordinary call is a phone that answers
 * a stranger without its owner touching it.
 */

/**
 * The `Alert-Info` value. Matches `AUTO_ANSWER_ALERT_INFO` in `apps/api/src/provisioning`.
 *
 * Sent bare rather than wrapped in the `<http://…>` URI Snom's example shows: RFC 3261 allows
 * `Alert-Info` parameters without a URI, Yealink's documented form has none, and Snom matches the
 * `info=` parameter rather than the URI it hangs off.
 */
export const AUTO_ANSWER_ALERT_INFO = "info=alert-autoanswer";

/** The `Call-Info` PARAMETER Grandstream looks for. Matches `AUTO_ANSWER_CALL_INFO` in `apps/api`. */
export const AUTO_ANSWER_CALL_INFO = "answer-after=0";

/**
 * The URI the `Call-Info` parameter hangs off.
 *
 * `Call-Info` requires a URI before its parameters, unlike `Alert-Info`, and none of the five
 * vendors dereferences it — Grandstream matches on `answer-after=` and ignores everything to its
 * left. So this is a syntactic placeholder rather than an address, and a deployment that wants its
 * own SIP domain in the header changes it here. It is a constant rather than a
 * {@link import("./plan-walker").PlanWalkerSettings} field precisely because no behaviour depends on
 * it: a setting would advertise a knob whose only effect is on a packet capture.
 */
export const AUTO_ANSWER_CALL_INFO_URI = "sip:localhost";

/**
 * The `OriginateRequest.variables` fragment that makes a handset answer itself.
 *
 * Spread into an originate's variables. Both headers, always — see the header note. Frozen and
 * shared rather than rebuilt per leg because a page fans out to every member of a group and this is
 * the same two strings every time.
 */
export const AUTO_ANSWER_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
	"PJSIP_HEADER(add,Alert-Info)": AUTO_ANSWER_ALERT_INFO,
	"PJSIP_HEADER(add,Call-Info)": `<${AUTO_ANSWER_CALL_INFO_URI}>;${AUTO_ANSWER_CALL_INFO}`,
});
