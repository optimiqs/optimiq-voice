import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The message surface's HTTP errors.
 *
 * Plain `HttpException`s rather than the area's `Schema.TaggedErrorClass` failures, because
 * `voicemail_message` is not a `PbxResource`: it does not go through the Effect repository (it must
 * not — `affectsRouting("voicemail_message")` is false, and routing an every-message write through
 * compile-on-write would recompile a tenant's whole call plan every time somebody pressed 7). The
 * bodies match the area's shape — `statusCode`, a `code` a client can switch on, a sentence — so
 * `apps/web`'s error reader needs no special case.
 */

export class VoicemailNotFoundException extends HttpException {
	constructor(kind: string, id: string) {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "VOICEMAIL_NOT_FOUND",
				message: `No ${kind} with id ${id} in this organization.`,
				kind,
				id,
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/**
 * No signing key is configured, so no playback link can be minted.
 *
 * A named 503 rather than an unsigned fallback. A deployment that has not decided on a key does not
 * accidentally serve a stranger's voicemail to the world; it says it cannot serve it at all.
 */
export class VoicemailSigningUnavailableException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.SERVICE_UNAVAILABLE,
				code: "VOICEMAIL_SIGNING_UNAVAILABLE",
				message:
					"Voicemail playback links are not available: no signing key is configured. Set PBX_VOICEMAIL_URL_SECRET (or CDR_RECORDING_URL_SECRET, which it inherits).",
			},
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	}
}

/**
 * The token is not one of ours, or names something this organization cannot see.
 *
 * One answer for both, deliberately: a forged token and a token for a row the tenant may not read
 * must be indistinguishable, or the difference between them is an oracle.
 */
export class VoicemailLinkInvalidException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.FORBIDDEN,
				code: "VOICEMAIL_LINK_INVALID",
				message: "This playback link is not valid.",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

export class VoicemailLinkExpiredException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "VOICEMAIL_LINK_EXPIRED",
				message: "This playback link has expired. Request a new one.",
			},
			HttpStatus.GONE,
		);
	}
}

/**
 * The row says there is audio and the object store disagrees.
 *
 * A 410 rather than a 404: the message existed, and saying so is what lets the UI distinguish "no
 * such message" from "the recording is gone" — the second of which is an operations problem
 * somebody can act on.
 */
export class VoicemailMediaGoneException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "VOICEMAIL_MEDIA_GONE",
				message: "The audio for this message is no longer in the object store.",
			},
			HttpStatus.GONE,
		);
	}
}
