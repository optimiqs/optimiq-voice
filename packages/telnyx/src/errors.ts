/**
 * Errors raised by the Telnyx client.
 *
 * Per the oikos naming convention (`plans/reference/oikos-conventions.md` §3) packages raise
 * `…Error`; `apps/api` translates them into Effect `…Failure` / HTTP `…Exception` at its own seam.
 * Nothing here knows about NestJS, Effect or HTTP status handling beyond the number the carrier
 * returned.
 *
 * ## Why the carrier's own error codes survive the trip
 *
 * A carrier failure is not one thing. "You asked for a number that was taken 40ms ago" (`10015`)
 * is a retry-with-another-number; "your account is not permitted to order in this country" is a
 * support ticket; "your token is wrong" is a platform misconfiguration that no tenant can fix.
 * Flattening those into "Telnyx said no" makes the admin UI unable to say anything useful and
 * makes an on-call engineer read logs to learn what a 422 body already said. So
 * {@link TelnyxApiError} keeps the whole `errors[]` array, and the API layer decides what a
 * tenant is allowed to see.
 */

/** One entry of Telnyx's `errors[]` envelope. */
export interface TelnyxApiErrorDetail {
	/** Telnyx's own numeric-ish error code, e.g. `"10015"`. Always carried through verbatim. */
	readonly code: string;
	readonly title: string;
	readonly detail?: string;
	readonly source?: { readonly pointer?: string; readonly parameter?: string };
	readonly meta?: Record<string, unknown>;
}

/** Base class so a consumer can catch every carrier failure with one `instanceof`. */
export class TelnyxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * The carrier answered with a non-2xx status.
 *
 * `status` is the HTTP status, `errors` is whatever Telnyx put in the body — empty when the body
 * was not the documented envelope, which happens for gateway errors produced in front of the API.
 */
export class TelnyxApiError extends TelnyxError {
	readonly status: number;
	readonly errors: readonly TelnyxApiErrorDetail[];
	readonly requestId?: string;
	readonly method: string;
	readonly path: string;

	constructor(input: {
		readonly status: number;
		readonly errors: readonly TelnyxApiErrorDetail[];
		readonly method: string;
		readonly path: string;
		readonly requestId?: string;
	}) {
		const summary =
			input.errors.length === 0
				? "no error detail"
				: input.errors.map((entry) => `${entry.code} ${entry.title}`).join("; ");
		super(`Telnyx ${input.method} ${input.path} failed with ${input.status}: ${summary}`);
		this.status = input.status;
		this.errors = input.errors;
		this.method = input.method;
		this.path = input.path;
		if (input.requestId !== undefined) {
			this.requestId = input.requestId;
		}
	}

	/** Whether any returned code matches — the shape a caller's `catch` wants to branch on. */
	hasCode(code: string): boolean {
		return this.errors.some((entry) => entry.code === code);
	}

	/**
	 * A 401/403 means our platform token is wrong or lacks a permission. Distinguished because it
	 * is never the tenant's fault and never fixable by retrying with different inputs.
	 */
	get isAuthentication(): boolean {
		return this.status === 401 || this.status === 403;
	}

	/** A 429 that survived the retry budget: the caller is being told to slow down, for real. */
	get isRateLimited(): boolean {
		return this.status === 429;
	}

	/** 5xx — the carrier, not the request. Safe to surface as "try again". */
	get isCarrierFault(): boolean {
		return this.status >= 500;
	}
}

/**
 * The request never produced a response: DNS, connect, TLS, socket reset, or our own timeout.
 *
 * Separate from {@link TelnyxApiError} because the two demand opposite handling on a *write*: a
 * 422 means nothing happened at the carrier, while a transport failure means we do not know
 * whether it did. Order creation carries an idempotency key precisely so this case can be retried
 * without ordering twice; see `resources/number-orders.ts`.
 */
export class TelnyxTransportError extends TelnyxError {
	readonly method: string;
	readonly path: string;
	readonly attempts: number;

	constructor(input: {
		readonly method: string;
		readonly path: string;
		readonly attempts: number;
		readonly cause: unknown;
	}) {
		super(
			`Telnyx ${input.method} ${input.path} did not complete after ${input.attempts} attempt(s): ${
				input.cause instanceof Error ? input.cause.message : String(input.cause)
			}`,
		);
		this.method = input.method;
		this.path = input.path;
		this.attempts = input.attempts;
		this.cause = input.cause;
	}
}

/**
 * A 2xx body did not match the schema this client was built against.
 *
 * This is deliberately fatal rather than "use what we can read". The client's whole value is that
 * everything above it can trust the types, and a silently-tolerated shape drift is how a renamed
 * field becomes `undefined` in a database column three layers up. When this fires, the fix is to
 * re-read `reference/telnyx-api.md` and update the schema — which is why the message names the
 * path and the failing field.
 */
export class TelnyxResponseShapeError extends TelnyxError {
	readonly method: string;
	readonly path: string;
	readonly issues: readonly string[];

	constructor(input: {
		readonly method: string;
		readonly path: string;
		readonly issues: readonly string[];
	}) {
		super(
			`Telnyx ${input.method} ${input.path} returned a body this client does not understand: ${input.issues.join(
				"; ",
			)}. Check packages/telnyx/reference/telnyx-api.md against the live API.`,
		);
		this.method = input.method;
		this.path = input.path;
		this.issues = input.issues;
	}
}

/** A webhook's signature could not be verified. Never distinguishes *why* to the caller's caller. */
export class TelnyxSignatureError extends TelnyxError {
	readonly reason:
		| "missing-signature"
		| "missing-timestamp"
		| "malformed-signature"
		| "malformed-timestamp"
		| "malformed-public-key"
		| "stale-timestamp"
		| "mismatch";

	constructor(reason: TelnyxSignatureError["reason"], detail?: string) {
		super(
			`Telnyx webhook signature rejected (${reason})${detail === undefined ? "" : `: ${detail}`}`,
		);
		this.reason = reason;
	}
}
