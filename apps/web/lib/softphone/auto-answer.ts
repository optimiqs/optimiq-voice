/**
 * The auto-answer signal, as the BROWSER softphone reads it off an incoming INVITE.
 *
 * Intercom (`*80`) and paging (`*81`) work by asking the far handset to pick up by itself. The
 * engine sends the request as two headers (`apps/engine/src/routing/auto-answer.ts`), sipd puts them
 * on the INVITE (`apps/sipd/internal/invite/originate.go`), and every desk phone in
 * `apps/api/src/provisioning/catalog/templates/` is provisioned to honour one of them. The browser
 * softphone is a handset on the same feature and had no equivalent: a page reached it as an ordinary
 * ringing call, so a paging group whose members are browser softphones announced into a set of
 * phones that were all still ringing when the pager finished speaking.
 *
 * ## The literals are a third copy, and that is stated rather than hidden
 *
 * `apps/engine/src/routing/auto-answer.ts` and `apps/api/src/provisioning/auto-answer.ts` each own
 * the same two strings and each say why they are duplicated rather than shared. This is the third
 * side of the same agreement, for the same reason — `apps/web` depends on neither app — and it
 * carries the same risk: edit one side and paging stops auto-answering with no test failing. The
 * matching is deliberately LOOSE (a substring of the header value) so a deployment that decorated
 * `Alert-Info` with a URI, as Snom's own documentation does, still auto-answers.
 *
 * ## This is not a security boundary
 *
 * A header is a request, honoured because this handset chose to. What stops a stranger opening a
 * microphone is that the INVITE has to authenticate and route through the tenant's own edge first —
 * the same gate every other call passes. The engine sends these headers on intercom and paging
 * originations and on nothing else.
 */

/** The `Alert-Info` token. Matches `AUTO_ANSWER_ALERT_INFO` in `apps/engine` and `apps/api`. */
export const AUTO_ANSWER_ALERT_INFO = "info=alert-autoanswer";

/** The `Call-Info` parameter, Broadsoft's convention. Matches `AUTO_ANSWER_CALL_INFO`. */
export const AUTO_ANSWER_CALL_INFO = "answer-after=";

/**
 * Whether this INVITE asks the handset to answer itself.
 *
 * Takes a header reader rather than a request object so it is testable without a SIP stack, and so
 * it works against anything that can name a header.
 *
 * `answer-after=` is matched with its VALUE checked to be zero: the parameter also expresses "answer
 * after N seconds", and a browser tab silently opening its microphone some seconds later is not a
 * behaviour anyone asked for. Anything other than `0` rings normally.
 */
export function wantsAutoAnswer(getHeader: (name: string) => string | undefined | null): boolean {
	const alertInfo = getHeader("Alert-Info") ?? "";
	if (alertInfo.toLowerCase().includes(AUTO_ANSWER_ALERT_INFO)) {
		return true;
	}
	const callInfo = getHeader("Call-Info") ?? "";
	const match = /answer-after\s*=\s*(\d+)/iu.exec(callInfo);
	return match !== null && Number(match[1]) === 0;
}
