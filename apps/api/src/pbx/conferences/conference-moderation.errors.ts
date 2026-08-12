import {
	ForbiddenException,
	HttpStatus,
	NotFoundException,
	NotImplementedException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { ConferenceControlAction } from "@optimiq-voice/events/schemas";

/**
 * The moderation surface's HTTP errors.
 *
 * Nest exceptions rather than `Schema.TaggedErrorClass` failures, for the reason
 * `queue-agent-session.errors.ts` records: the PBX failures exist to cross the Effect seam, and this
 * service is not below it — its store is a KV read and a request-reply, neither of which is a
 * repository. The body contract is identical (`{ statusCode, code, message, … }`) because
 * `apps/web` switches on `code` and must not care which layer produced the failure.
 *
 * ```jsonc
 * // 403 — authenticated, holds conferences.read, does not hold conferences.moderate
 * { "statusCode": 403, "code": "CONFERENCE_MODERATE_FORBIDDEN", "message": "…" }
 * // 404 — the room exists in the database and nobody is in it
 * { "statusCode": 404, "code": "CONFERENCE_NOT_RUNNING", "conferenceId": "…" }
 * // 404 — the meeting is running and that participant is not in it
 * { "statusCode": 404, "code": "CONFERENCE_MEMBER_NOT_FOUND", "memberRef": "…" }
 * // 501 — no media plane on this platform can serve the action
 * { "statusCode": 501, "code": "CONFERENCE_ACTION_NOT_SERVABLE", "action": "volume", "message": "…" }
 * // 503 — no engine could be reached, so nothing happened
 * { "statusCode": 503, "code": "CONFERENCE_CONTROL_UNAVAILABLE", "message": "…" }
 * ```
 */

/**
 * The caller may see conferences and may not moderate one.
 *
 * A distinct code from the guard's own 403 because the two are fixed differently: the guard's means
 * "you cannot reach this surface", and this one means "you can see the room and cannot act on it",
 * which is a grant an administrator adds in one click.
 */
export class ConferenceModerateForbiddenException extends ForbiddenException {
	constructor(message: string) {
		super({
			statusCode: HttpStatus.FORBIDDEN,
			code: "CONFERENCE_MODERATE_FORBIDDEN",
			message,
		});
	}
}

/**
 * The room exists as a configuration row and no meeting is happening in it.
 *
 * A 404 and not a 409, because there is nothing to act on: the resource named by the URL —
 * `/conferences/:id/participants/:ref` — genuinely does not exist right now. A distinct code from
 * `PBX_NOT_FOUND` so a console can say "nobody is in this room" instead of "no such room", which is
 * a materially different thing for an operator staring at a room they configured this morning.
 */
export class ConferenceNotRunningException extends NotFoundException {
	constructor(conferenceId: string) {
		super({
			statusCode: HttpStatus.NOT_FOUND,
			code: "CONFERENCE_NOT_RUNNING",
			message: "No meeting is running in this conference room.",
			conferenceId,
		});
	}
}

/**
 * The meeting is running and that participant is not in it.
 *
 * Produced only after EVERY contributing engine has said so, which is what makes it a fact rather
 * than a guess: one instance answering "not mine" means the member is somewhere else, and only the
 * exhausted list means they have left.
 */
export class ConferenceMemberNotFoundException extends NotFoundException {
	constructor(memberRef: string) {
		super({
			statusCode: HttpStatus.NOT_FOUND,
			code: "CONFERENCE_MEMBER_NOT_FOUND",
			message: "That participant is not in this meeting.",
			memberRef,
		});
	}
}

/**
 * No media plane on this platform can serve the action.
 *
 * 501 and not 400: the request is well formed and the platform cannot do it, which is exactly what
 * `Not Implemented` means and is the one status a client can use to hide the control rather than
 * retry it. `volume` is the only action that produces this today — Asterisk has no per-participant
 * gain on a mixing bridge, and `apps/mediad`'s mixer has one with no command that reaches it.
 */
export class ConferenceActionNotServableException extends NotImplementedException {
	constructor(action: ConferenceControlAction, message: string) {
		super({
			statusCode: HttpStatus.NOT_IMPLEMENTED,
			code: "CONFERENCE_ACTION_NOT_SERVABLE",
			message,
			action,
		});
	}
}

/**
 * Nothing was reached, so nothing happened.
 *
 * The important half is the second clause. A moderation command that half-applied would leave a
 * moderator looking at a participant list that disagrees with the room; this status promises the
 * opposite, which is why the client is a refusal-not-throw and every unreachable engine ends here.
 */
export class ConferenceControlUnavailableException extends ServiceUnavailableException {
	constructor(message: string) {
		super({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "CONFERENCE_CONTROL_UNAVAILABLE",
			message,
		});
	}
}
