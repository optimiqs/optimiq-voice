import {
	ConflictException,
	HttpStatus,
	NotFoundException,
	NotImplementedException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type {
	CallControlRefusalReason,
	SessionVerbRefusalReason,
} from "@optimiq-voice/events/schemas";

/**
 * The recording-control surface's HTTP errors.
 *
 * Nest exceptions with this area's body shape (`{ statusCode, code, message, … }`), for the reason
 * `conference-moderation.errors.ts` records: `apps/web` switches on `code` and must not care which
 * layer produced the failure.
 *
 * ```jsonc
 * // 404 — no live call with that id can be reached
 * { "statusCode": 404, "code": "CALL_NOT_CONTROLLABLE", "callId": "…" }
 * // 409 — the session went away between the lookup and the verb
 * { "statusCode": 409, "code": "CALL_RECORDING_NOT_PAUSABLE", "reason": "unknown-leg" }
 * // 501 — this call's media plane cannot pause a recording (ARI shortens the file)
 * { "statusCode": 501, "code": "CALL_RECORDING_PAUSE_UNSUPPORTED" }
 * // 503 — no engine answered, so the recording is in the state it was already in
 * { "statusCode": 503, "code": "CALL_ENGINE_UNAVAILABLE" }
 * ```
 */

/**
 * No live call with that id can be reached, on either transport.
 *
 * A 404 rather than a 409, on the `CONFERENCE_NOT_RUNNING` argument: the resource the URL names —
 * the recording control of a live call — genuinely does not exist right now. Every cause reduces to
 * the same one thing for a caller, which is why they share a status: the call has ended, or the
 * channels bucket has no live leg for it, or the engine that answered no longer holds it. All three
 * mean "stop showing the control", and none is retryable by the person pressing it.
 *
 * The one cause NOT folded in here is a reachable call the engine refused, which is
 * {@link CallRecordingNotPausableException} — because that one the control stays up for.
 */
export class CallNotControllableException extends NotFoundException {
	constructor(callId: string) {
		super({
			statusCode: HttpStatus.NOT_FOUND,
			code: "CALL_NOT_CONTROLLABLE",
			message:
				"No live call with that id could be reached, so its recording cannot be paused. It has " +
				"most likely ended.",
			callId,
		});
	}
}

/**
 * The engine refused the verb.
 *
 * The refusal reason rides in the body rather than being flattened into the message, because a
 * client acts on it: `unknown-leg` and `session-mismatch` mean the call is gone and the control
 * should disappear, where `not-permitted` and `not-recording` mean this call has no recording
 * running and the control should stay and say so.
 *
 * The union covers BOTH transports because a client must not have to know which one carried its
 * request: an application-driven call is refused over `session-verb` and a PBX call over
 * `call-control`, and the two vocabularies are neighbours rather than synonyms — the reason rides
 * out verbatim rather than being flattened into one of them.
 */
export class CallRecordingNotPausableException extends ConflictException {
	constructor(
		reason: SessionVerbRefusalReason | CallControlRefusalReason,
		detail: string | undefined,
	) {
		super({
			statusCode: HttpStatus.CONFLICT,
			code: "CALL_RECORDING_NOT_PAUSABLE",
			message: "The engine would not change this call's recording.",
			reason,
			...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
		});
	}
}

/**
 * The verb is not implemented on the media plane this call is running on.
 *
 * 501 and not 409, for the reason `CONFERENCE_ACTION_NOT_SERVABLE` states: the request is well
 * formed and the platform cannot do it, and it is the one status a console can use to HIDE the
 * control rather than retry it. Real today — `AriMediaAdapter` refuses `pauseRecording` because
 * ARI's pause shortens the file, so the intervals it reported would not name the silence they
 * describe.
 */
export class CallRecordingPauseUnsupportedException extends NotImplementedException {
	constructor(detail: string | undefined) {
		super({
			statusCode: HttpStatus.NOT_IMPLEMENTED,
			code: "CALL_RECORDING_PAUSE_UNSUPPORTED",
			message: "This call's media plane cannot pause a recording without cutting the file.",
			...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
		});
	}
}

/**
 * Nothing was reached, so nothing happened.
 *
 * The second clause is the one that matters on a PCI path: a pause that half-applied would leave an
 * agent believing the card number is not being recorded while it is. This status promises the
 * opposite — the recording is in the state it was already in, and the caller must not read a card
 * number until a pause has been acknowledged.
 */
export class CallRecordingUnavailableException extends ServiceUnavailableException {
	constructor(detail: string) {
		super({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "CALL_ENGINE_UNAVAILABLE",
			message: "No call engine answered. The recording was not changed.",
			detail: detail.slice(0, 256),
		});
	}
}
