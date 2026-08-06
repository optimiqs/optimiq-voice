import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The media library's HTTP errors.
 *
 * Plain `HttpException`s rather than the area's `Schema.TaggedErrorClass` failures, for the reason
 * `voicemail.errors.ts` records: these are raised by services that hold a database client and a
 * filesystem rather than by the Effect repository, and inventing a typed failure for a path that
 * never enters an `Effect` would be ceremony. The BODIES match the area's shape — `statusCode`, a
 * `code` a client can switch on, a sentence a person can act on — so `apps/web`'s error reader
 * needs no special case.
 *
 * One code deserves its own note. {@link MediaUploadRejectedException} is a **400 with the reason
 * in `message`**, not a 415 and not a 422. 415 would say "I do not serve this media type", which is
 * about the REQUEST's encoding rather than about the file inside it; 422 is the area's compile
 * failure and carries `diagnostics`. What actually happened is that the body was well-formed and
 * its contents were wrong, which is what 400 means here and everywhere else in this area
 * (`PBX_INVALID_BODY`).
 */

export class MediaNotFoundException extends HttpException {
	constructor(kind: string, id: string) {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "MEDIA_NOT_FOUND",
				message: `No ${kind} with id ${id} in this organization.`,
				kind,
				id,
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/**
 * The upload was refused: no file part, the wrong content type, bytes that are not audio we can
 * store, or more bytes than the cap allows.
 *
 * One exception for all four, with the reason spelled out, because they are one thing from the
 * uploader's point of view — "this file did not go in, and here is why" — and a form renders them
 * in the same place. `field` names the multipart part so a future multi-part form can attach it.
 */
export class MediaUploadRejectedException extends HttpException {
	constructor(reason: string, field = "file") {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "MEDIA_UPLOAD_REJECTED",
				message: reason,
				issues: [{ field, code: "custom", message: reason }],
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * The upload exceeded the configured cap.
 *
 * A 413 rather than the 400 above, because this one is about the REQUEST's size and because a
 * client that streams a large file benefits from the distinct status: it can stop uploading. The
 * cap is stated in the message so the UI does not have to know it independently.
 */
export class MediaUploadTooLargeException extends HttpException {
	constructor(maxBytes: number) {
		super(
			{
				statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
				code: "MEDIA_UPLOAD_TOO_LARGE",
				message:
					`This file is larger than the ${formatBytes(maxBytes)} upload limit. ` +
					"Trim the recording, or raise PBX_MEDIA_MAX_UPLOAD_BYTES.",
				maxBytes,
			},
			HttpStatus.PAYLOAD_TOO_LARGE,
		);
	}
}

/** No signing key is configured, so no playback link can be minted. See `voicemail.errors.ts`. */
export class MediaSigningUnavailableException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.SERVICE_UNAVAILABLE,
				code: "MEDIA_SIGNING_UNAVAILABLE",
				message:
					"Media playback links are not available: no signing key is configured. " +
					"Set PBX_VOICEMAIL_URL_SECRET (or CDR_RECORDING_URL_SECRET, which it inherits).",
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
export class MediaLinkInvalidException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.FORBIDDEN,
				code: "MEDIA_LINK_INVALID",
				message: "This playback link is not valid.",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

export class MediaLinkExpiredException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "MEDIA_LINK_EXPIRED",
				message: "This playback link has expired. Request a new one.",
			},
			HttpStatus.GONE,
		);
	}
}

/** The row says there is audio and the object store disagrees. A 410, as in the CDR area. */
export class MediaGoneException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "MEDIA_GONE",
				message: "The audio for this item is no longer in the object store.",
			},
			HttpStatus.GONE,
		);
	}
}

/** The greeting kind asked for has no active recording, so there is nothing to activate or clear. */
export class MediaGreetingConflictException extends HttpException {
	constructor(message: string) {
		super(
			{ statusCode: HttpStatus.CONFLICT, code: "MEDIA_GREETING_CONFLICT", message },
			HttpStatus.CONFLICT,
		);
	}
}

function formatBytes(bytes: number): string {
	const mebibytes = bytes / (1024 * 1024);
	return mebibytes >= 1
		? `${mebibytes.toFixed(mebibytes < 10 ? 1 : 0)} MB`
		: `${String(Math.round(bytes / 1024))} kB`;
}
