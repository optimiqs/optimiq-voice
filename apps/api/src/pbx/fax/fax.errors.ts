import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The fax slice's HTTP errors.
 *
 * Plain `HttpException`s that keep the PBX body contract (`{ statusCode, code, message, … }`) so
 * `apps/web` switches on `code` and never on which layer produced the failure — the same choice
 * `voicemail.errors.ts` and `carrier.errors.ts` make.
 */

/** No fax server, or no fax message, by that id in this tenant. */
export class FaxNotFoundException extends HttpException {
	constructor(kind: "server" | "message" = "server") {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "FAX_NOT_FOUND",
				message: kind === "server" ? "No fax server with that id." : "No fax with that id.",
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/** A send was asked for against a fax server that has no DID bound, or is disabled. */
export class FaxNotSendableException extends HttpException {
	constructor(reason: "no-number" | "disabled") {
		super(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "FAX_NOT_SENDABLE",
				message:
					reason === "no-number"
						? "This fax server has no phone number bound, so it cannot send. Bind a fax-enabled DID first."
						: "This fax server is disabled.",
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/** The link secret is not configured, so a media link cannot be minted or verified. */
export class FaxSigningUnavailableException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.SERVICE_UNAVAILABLE,
				code: "FAX_SIGNING_UNAVAILABLE",
				message: "Fax media links are unavailable: set FAX_MEDIA_URL_SECRET to enable them.",
			},
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	}
}

/** A media token failed to verify, or named a fax that has no stored document. */
export class FaxLinkInvalidException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.FORBIDDEN,
				code: "FAX_LINK_INVALID",
				message: "This fax link is not valid.",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

/** A media token verified but has expired. */
export class FaxLinkExpiredException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "FAX_LINK_EXPIRED",
				message: "This fax link has expired.",
			},
			HttpStatus.GONE,
		);
	}
}

/** The document a link named is gone from the store. */
export class FaxMediaGoneException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "FAX_MEDIA_GONE",
				message: "The fax document is no longer available.",
			},
			HttpStatus.GONE,
		);
	}
}
