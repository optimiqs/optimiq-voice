import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The messaging area's HTTP errors.
 *
 * Plain `HttpException`s keeping the PBX body contract (`{ statusCode, code, message }`) so
 * `apps/web` switches on `code` and never on which layer produced the failure — the same choice
 * `fax.errors.ts` and `carrier.errors.ts` make.
 *
 * # The three refusals that carry a REASON, and why they are not one error
 *
 * A blocked send is the single most important thing this feature does, and "you cannot send" is a
 * useless thing to tell somebody. The three ways a send is refused are three different problems with
 * three different owners:
 *
 * - `MESSAGING_NUMBER_NOT_REGISTERED` — the ADMIN has work to do (register the brand, get the
 *   campaign approved, assign this number). The message quotes the stored `registrationReason`,
 *   which is the carrier's or the platform's own words about what is missing.
 * - `MESSAGING_RECIPIENT_OPTED_OUT` — nobody has work to do. This person said stop, and the correct
 *   outcome is that the message is not sent and the agent understands why.
 * - `MESSAGING_QUIET_HOURS` — the message is fine and the CLOCK is wrong. It quotes the window and
 *   the current local time so the agent knows when to try again.
 *
 * Collapsing them into one 422 would produce a UI that can only say "blocked", which is how a
 * compliance feature becomes a feature people work around.
 */

/** No messaging number, conversation, message, brand, campaign or opt-out by that id in this tenant. */
export class MessagingNotFoundException extends HttpException {
	constructor(
		kind:
			| "number"
			| "conversation"
			| "message"
			| "brand"
			| "campaign"
			| "toll-free-verification"
			| "opt-out",
	) {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "MESSAGING_NOT_FOUND",
				message: `No ${kind.replace(/-/gu, " ")} with that id.`,
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/** No provider is configured, so nothing can be sent or received. */
export class MessagingNotConfiguredException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.SERVICE_UNAVAILABLE,
				code: "MESSAGING_NOT_CONFIGURED",
				message:
					"Messaging is not configured on this deployment: set MESSAGING_DRIVER to enable it.",
			},
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	}
}

/**
 * The hard block on sending from an unregistered number, carrying the named reason.
 *
 * A 422 and not a 403: the request is well-formed and the caller is permitted: the *number* is not
 * in a state where the carriers will carry its traffic. A 403 would send an integrator looking at
 * their API key.
 */
export class MessagingNumberNotRegisteredException extends HttpException {
	constructor(e164: string, reason: string) {
		super(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "MESSAGING_NUMBER_NOT_REGISTERED",
				message: `${e164} cannot send: ${reason}`,
				/** Machine-readable, so a UI can deep-link to the right settings page. */
				e164,
				reason,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/** The recipient is on this number's suppression list. */
export class MessagingRecipientOptedOutException extends HttpException {
	constructor(remoteE164: string, optedOutAt: Date) {
		super(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "MESSAGING_RECIPIENT_OPTED_OUT",
				message:
					`${remoteE164} opted out of messages from this number on ` +
					`${optedOutAt.toISOString().slice(0, 10)} and cannot be messaged again unless they ` +
					"text START.",
				remoteE164,
				optedOutAt: optedOutAt.toISOString(),
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/** Outside the campaign's declared sendable window. */
export class MessagingQuietHoursException extends HttpException {
	constructor(localTime: string, window: string) {
		super(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "MESSAGING_QUIET_HOURS",
				message:
					`It is ${localTime} for this campaign, which sends only between ${window}. ` +
					"The message was not queued.",
				localTime,
				window,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/** Messaging was asked for on a DID that already has it, or on one that is not this tenant's. */
export class MessagingNumberConflictException extends HttpException {
	constructor(detail: string) {
		super(
			{
				statusCode: HttpStatus.CONFLICT,
				code: "MESSAGING_NUMBER_CONFLICT",
				message: detail,
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** A registration action was asked for in a state that does not allow it. */
export class MessagingRegistrationStateException extends HttpException {
	constructor(detail: string) {
		super(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "MESSAGING_REGISTRATION_STATE",
				message: detail,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/** The webhook signature did not verify. */
export class MessagingSignatureInvalidException extends HttpException {
	constructor(reason: string) {
		super(
			{
				statusCode: HttpStatus.FORBIDDEN,
				code: "MESSAGING_SIGNATURE_INVALID",
				message: "The messaging webhook signature could not be verified.",
				reason,
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

/** The media link secret is not configured, so a link cannot be minted or verified. */
export class MessagingMediaSigningUnavailableException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.SERVICE_UNAVAILABLE,
				code: "MESSAGING_MEDIA_SIGNING_UNAVAILABLE",
				message: "MMS media links are unavailable: set MESSAGING_MEDIA_URL_SECRET to enable them.",
			},
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	}
}

/** A media token failed to verify, or named a message with no stored media. */
export class MessagingMediaLinkInvalidException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.FORBIDDEN,
				code: "MESSAGING_MEDIA_LINK_INVALID",
				message: "This media link is not valid.",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

/** A media token verified but has expired. */
export class MessagingMediaLinkExpiredException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "MESSAGING_MEDIA_LINK_EXPIRED",
				message: "This media link has expired.",
			},
			HttpStatus.GONE,
		);
	}
}

/** The media a link named is gone from the store — purged by retention, or never downloaded. */
export class MessagingMediaGoneException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "MESSAGING_MEDIA_GONE",
				message: "The attachment is no longer available.",
			},
			HttpStatus.GONE,
		);
	}
}

/** An uploaded attachment was refused before it reached the store. */
export class MessagingMediaRejectedException extends HttpException {
	constructor(detail: string) {
		super(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "MESSAGING_MEDIA_REJECTED",
				message: detail,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}
