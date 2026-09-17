import { ApiError } from "../api-client";

/**
 * The messaging area's failure taxonomy, and the three refusals that are the point of the feature.
 *
 * Every body is the platform's standard shape — `{ statusCode, code, message }` — and the client
 * switches on `code`. Three of those codes are not errors in the usual sense at all; they are the
 * platform telling an operator, in a sentence written by the layer that actually knows, why this
 * particular message may not be sent:
 *
 * ```jsonc
 * { "statusCode": 409, "code": "MESSAGING_NUMBER_NOT_REGISTERED", "message": "+1… is not registered with the carriers: the 10DLC campaign is still pending." }
 * { "statusCode": 409, "code": "MESSAGING_RECIPIENT_OPTED_OUT",   "message": "+1… replied STOP on 3 February and has not opted back in." }
 * { "statusCode": 409, "code": "MESSAGING_QUIET_HOURS",           "message": "It is 21:40 in America/New_York; this campaign's quiet hours run 21:00–08:00." }
 * ```
 *
 * ## The message is shown VERBATIM, and that is the whole product
 *
 * A blocked send that says "cannot send" is indistinguishable from a bug. Each of these three
 * sends the operator somewhere completely different — chase the registration, respect a withdrawn
 * consent, or come back in the morning — and only the server knows which number, which campaign
 * and which clock. So nothing here rewrites those sentences; {@link readSendBlock} extracts them
 * and the composer renders them as they arrived. The only copy this module owns is the short
 * heading above each one, which names the CATEGORY the sentence belongs to.
 */

export const MESSAGING_BLOCK_CODES = [
	"MESSAGING_NUMBER_NOT_REGISTERED",
	"MESSAGING_RECIPIENT_OPTED_OUT",
	"MESSAGING_QUIET_HOURS",
] as const;
export type MessagingBlockCode = (typeof MESSAGING_BLOCK_CODES)[number];

const BLOCK_CODE_SET: ReadonlySet<string> = new Set<string>(MESSAGING_BLOCK_CODES);

export interface MessagingErrorBody {
	readonly statusCode?: number;
	readonly code?: string;
	readonly message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The parsed body of a messaging failure, or `undefined` when this is not one. */
export function messagingErrorBody(error: unknown): MessagingErrorBody | undefined {
	if (!(error instanceof ApiError) || !isRecord(error.body)) {
		return undefined;
	}
	const { code } = error.body;
	return typeof code === "string" ? (error.body as MessagingErrorBody) : undefined;
}

export function messagingErrorCode(error: unknown): string | undefined {
	return messagingErrorBody(error)?.code;
}

export interface SendBlock {
	readonly code: MessagingBlockCode;
	/** The heading. Names the category; never replaces the server's sentence. */
	readonly title: string;
	/** The server's own `message`, unmodified. */
	readonly message: string;
}

/**
 * The headings. One per code, and each is a NOUN PHRASE rather than an apology, so the sentence
 * underneath reads as the explanation rather than as a second attempt at the same thing.
 */
const BLOCK_TITLES: Readonly<Record<MessagingBlockCode, string>> = {
	MESSAGING_NUMBER_NOT_REGISTERED: "This number is not registered for messaging",
	MESSAGING_RECIPIENT_OPTED_OUT: "This recipient has opted out",
	MESSAGING_QUIET_HOURS: "Quiet hours are in force",
};

/**
 * The three refusals, read off a failed send.
 *
 * Returns `undefined` for everything else — a 500, a validation failure, a dropped connection —
 * because those are transient or addressable and must NOT latch the composer shut. Only a stated
 * policy refusal disables the control.
 *
 * A block with no `message` still yields a block: the code alone is enough to know the composer
 * must close, and the fallback names the category rather than inventing a reason the server did
 * not give.
 */
export function readSendBlock(error: unknown): SendBlock | undefined {
	const body = messagingErrorBody(error);
	if (!body?.code || !BLOCK_CODE_SET.has(body.code)) {
		return undefined;
	}
	const code = body.code as MessagingBlockCode;
	const message = body.message?.trim();
	return {
		code,
		title: BLOCK_TITLES[code],
		message:
			message && message.length > 0
				? message
				: "The platform refused this send and did not say why. Check the number's registration and the recipient's consent.",
	};
}

/**
 * A short line for a toast, for the failures that are NOT one of the three.
 *
 * The three never reach a toast: they are rendered in the composer where they can be re-read, and
 * a corner overlay that vanishes is the worst possible home for the one sentence explaining why a
 * message did not go.
 */
export function messagingToastMessage(error: unknown, fallback: string): string {
	const body = messagingErrorBody(error);
	if (body?.code === "MESSAGING_MEDIA_TOO_LARGE" || body?.code === "MESSAGING_MEDIA_REJECTED") {
		return body.message ?? "That attachment was rejected";
	}
	if (error instanceof ApiError && error.message.length > 0) {
		return error.message;
	}
	return fallback;
}
