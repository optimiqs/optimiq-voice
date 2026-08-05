/**
 * Errors raised by the ARI adapter.
 *
 * Per the oikos naming convention (`plans/reference/oikos-conventions.md` §3) packages raise
 * `…Error`; the engine translates them into Effect `…Failure` at its own seam. Nothing here knows
 * about NestJS, Effect or HTTP status semantics beyond the numeric status Asterisk returned.
 */

/** Base class, so one `instanceof` catches every failure this adapter can produce. */
export class AriError extends Error {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/**
 * A non-2xx ARI response.
 *
 * `status` is what routing and retry logic actually key off, so it is a first-class field rather
 * than something to parse back out of the message:
 *
 * - `404` — the channel/bridge/playback is gone. Almost always a race with a hangup, and almost
 *   always benign: the engine treats it as "already done" rather than as a failure.
 * - `409` — the resource is in a state that forbids the operation (answering a destroyed channel,
 *   adding a channel to a bridge it already left).
 * - `422` — Asterisk understood the request and refused it (unknown endpoint technology, a media
 *   URI it cannot resolve).
 *
 * `asteriskMessage` is the `message` field of ARI's error body, which is the only place Asterisk
 * explains itself; it is preserved verbatim because it is the difference between "422" and
 * "422: Endpoint not found".
 */
export class AriHttpError extends AriError {
	readonly status: number;
	readonly method: string;
	/** Request path WITHOUT credentials — never the full URL, which can carry `api_key`. */
	readonly path: string;
	readonly asteriskMessage?: string;
	readonly body?: string;

	constructor(input: {
		readonly status: number;
		readonly method: string;
		readonly path: string;
		readonly asteriskMessage?: string;
		readonly body?: string;
	}) {
		const detail = input.asteriskMessage === undefined ? "" : `: ${input.asteriskMessage}`;
		super(`ARI ${input.method} ${input.path} failed with ${String(input.status)}${detail}`);
		this.status = input.status;
		this.method = input.method;
		this.path = input.path;
		this.asteriskMessage = input.asteriskMessage;
		this.body = input.body;
	}

	/** `404` — the resource no longer exists. The engine's cue to stop, not to retry. */
	get isNotFound(): boolean {
		return this.status === 404;
	}

	/** `409` — the resource exists but refuses the operation in its current state. */
	get isConflict(): boolean {
		return this.status === 409;
	}

	/**
	 * Whether re-issuing the same request could plausibly succeed. `429` and 5xx only: a 4xx
	 * decision by Asterisk will be the same decision next time, and retrying an originate on a
	 * `422` is how duplicate calls get placed.
	 */
	get isRetryable(): boolean {
		return this.status === 429 || this.status >= 500;
	}
}

/** The transport itself failed — DNS, connection refused, TLS, abort, timeout. */
export class AriTransportError extends AriError {
	readonly method: string;
	readonly path: string;

	constructor(method: string, path: string, options?: { readonly cause?: unknown }) {
		super(`ARI ${method} ${path} could not reach Asterisk`, options);
		this.method = method;
		this.path = path;
	}
}

/**
 * Asterisk answered, but not with what the schema says it must. Raised rather than swallowed:
 * a `Channel` without an `id` is not a channel, and letting it through would surface three call
 * stacks later as `undefined` where a channel id belongs.
 */
export class AriResponseShapeError extends AriError {
	readonly method: string;
	readonly path: string;
	readonly issues: readonly string[];

	constructor(method: string, path: string, issues: readonly string[]) {
		super(`ARI ${method} ${path} returned an unexpected shape: ${issues.join("; ")}`);
		this.method = method;
		this.path = path;
		this.issues = issues;
	}
}

/** A frame arrived on the event socket that is not a JSON object with a string `type`. */
export class AriEventParseError extends AriError {
	/** Truncated payload — event frames can carry caller-id data, so this is capped, not full. */
	readonly sample: string;

	constructor(reason: string, sample: string) {
		super(`ARI event could not be parsed: ${reason}`);
		this.sample = sample;
	}
}

/** The event WebSocket could not be established or was closed abnormally. */
export class AriSocketError extends AriError {
	readonly code?: number;
	readonly reason?: string;

	constructor(message: string, input: { readonly code?: number; readonly reason?: string } = {}) {
		super(message);
		this.code = input.code;
		this.reason = input.reason;
	}
}
