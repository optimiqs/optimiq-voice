import { z } from "zod";
import {
	TelnyxApiError,
	type TelnyxApiErrorDetail,
	TelnyxResponseShapeError,
	TelnyxTransportError,
} from "./errors";
import {
	backoffDelayMs,
	DEFAULT_RETRY_POLICY,
	isRetryableStatus,
	parseRateLimitResetMs,
	parseRetryAfterMs,
	type RetryPolicy,
	sleep,
} from "./retry";

/**
 * The one place in this package that performs I/O.
 *
 * Everything above it is a resource module that describes a request and a response schema; nothing
 * above it touches `fetch`, headers, retries, or status codes. That separation is what lets the
 * whole resource surface be tested against the in-package fake server with no mocking of the
 * global `fetch`, and what keeps the retry policy from being re-implemented eleven times.
 */

/** Telnyx API v2, the only version this client speaks. */
export const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * The call signature this transport uses, rather than `typeof globalThis.fetch`.
 *
 * The global type carries `preconnect`, a property no test double has any business implementing;
 * requiring it would make every injected stub a type error for a reason unrelated to what the stub
 * is for. Structural is also honest: this module calls `fetch(url, init)` and nothing else.
 */
export type TelnyxFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelnyxClientOptions {
	/** The platform's API key. Never a per-tenant value — see decision D5. */
	readonly apiKey: string;
	/** Overridden by `TELNYX_API_BASE` in tests so the fake server can stand in. */
	readonly baseUrl?: string;
	readonly retry?: Partial<RetryPolicy>;
	/** Per-attempt timeout. The retry budget multiplies this, so keep the product sane. */
	readonly timeoutMs?: number;
	/** Injected for tests; defaults to the global. */
	readonly fetch?: TelnyxFetch;
	/** Injected for tests so backoff is deterministic and instant. */
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly random?: () => number;
	/** Called once per completed attempt. The API layer wires this to its logger. */
	readonly onAttempt?: (event: TelnyxAttemptEvent) => void;
}

export interface TelnyxAttemptEvent {
	readonly method: string;
	readonly path: string;
	/** Zero-based. */
	readonly attempt: number;
	readonly status?: number;
	readonly durationMs: number;
	readonly retryInMs?: number;
	readonly error?: unknown;
}

export interface TelnyxRequest<TSchema extends z.ZodType> {
	readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	/** Path below the base, leading slash included, e.g. `/phone_numbers`. */
	readonly path: string;
	readonly query?: Record<string, string | number | boolean | undefined>;
	readonly body?: unknown;
	/**
	 * Sent as `Idempotency-Key`.
	 *
	 * Telnyx honours this on seven email/storage endpoints only — never on the number, connection
	 * or profile endpoints this client uses. It is kept because the transport should not have an
	 * opinion about which paths grow support later, and because the fake server asserts we do not
	 * send it where it would be rejected with `10015`.
	 */
	readonly idempotencyKey?: string;
	/**
	 * `false` for a request whose repetition would create a second billable resource.
	 *
	 * Defaults to `true`. See the header of `retry.ts`: without carrier-side idempotency, retrying
	 * `POST /number_orders` through a timeout is how one order becomes two.
	 */
	readonly retryable?: boolean;
	readonly schema: TSchema;
	/** `true` when a 204/empty body is the documented success (DELETE on some resources). */
	readonly allowEmptyBody?: boolean;
}

/**
 * The error envelope, parsed permissively and normalized in TypeScript rather than in a zod
 * transform.
 *
 * Two reasons, both of which have bitten this file. `code` is a **string** on the wire despite one
 * of Telnyx's two conflicting spec definitions declaring it an integer, so it has to accept both —
 * and a zod `.transform()` doing that coercion infers differently across zod major versions, which
 * matters here because `apps/api` still pins zod 3 and compiles this package's sources directly.
 * Doing the narrowing by hand is immune to both problems and reads as what it is.
 *
 * The parse is also deliberately total: an error body that does not match must never throw on its
 * way to becoming an error, or a 502 from a proxy in front of Telnyx turns into an unhandled
 * exception instead of a `TelnyxApiError` with an empty `errors` array.
 */
const errorEnvelope = z.looseObject({
	errors: z
		.array(
			z.looseObject({
				code: z.union([z.string(), z.number()]).optional(),
				title: z.string().optional(),
				detail: z.string().optional(),
				source: z
					.looseObject({ pointer: z.string().optional(), parameter: z.string().optional() })
					.optional(),
				meta: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.optional(),
});

/**
 * Query serialization.
 *
 * Telnyx uses bracketed filter parameters (`filter[country_code]`, `filter[phone_number][contains]`)
 * which `URLSearchParams` encodes correctly as long as the caller hands over the literal key. The
 * resource modules therefore build the flat key themselves rather than passing a nested object
 * through a stringifier that would have to invent a bracket convention.
 *
 * `undefined` values are dropped rather than serialized as the string `"undefined"` — an
 * unspecified area code must not become a filter for numbers containing "undefined".
 */
function buildUrl(
	baseUrl: string,
	path: string,
	query: Record<string, string | number | boolean | undefined> | undefined,
): string {
	const url = `${baseUrl.replace(/\/+$/u, "")}${path}`;
	if (query === undefined) {
		return url;
	}
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) {
			continue;
		}
		params.set(key, String(value));
	}
	const serialized = params.toString();
	return serialized.length === 0 ? url : `${url}?${serialized}`;
}

function readErrors(payload: unknown): readonly TelnyxApiErrorDetail[] {
	const parsed = errorEnvelope.safeParse(payload);
	if (!parsed.success) {
		return [];
	}
	return (parsed.data.errors ?? []).map((entry) => ({
		code: entry.code === undefined ? "" : String(entry.code),
		title: entry.title ?? "",
		...(entry.detail === undefined ? {} : { detail: entry.detail }),
		...(entry.source === undefined ? {} : { source: entry.source }),
		...(entry.meta === undefined ? {} : { meta: entry.meta }),
	}));
}

export interface TelnyxTransport {
	request: <TSchema extends z.ZodType>(
		request: TelnyxRequest<TSchema>,
	) => Promise<z.infer<TSchema>>;
	readonly baseUrl: string;
}

export function createTelnyxTransport(options: TelnyxClientOptions): TelnyxTransport {
	const baseUrl = options.baseUrl ?? TELNYX_API_BASE;
	const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
	const doFetch = options.fetch ?? globalThis.fetch;
	const wait = options.sleep ?? sleep;
	const random = options.random ?? Math.random;
	const timeoutMs = options.timeoutMs ?? 15_000;

	async function request<TSchema extends z.ZodType>(
		input: TelnyxRequest<TSchema>,
	): Promise<z.infer<TSchema>> {
		const url = buildUrl(baseUrl, input.path, input.query);
		const headers: Record<string, string> = {
			authorization: `Bearer ${options.apiKey}`,
			accept: "application/json",
		};
		if (input.body !== undefined) {
			headers["content-type"] = "application/json";
		}
		if (input.idempotencyKey !== undefined) {
			headers["idempotency-key"] = input.idempotencyKey;
		}

		const maxAttempts = input.retryable === false ? 1 : policy.maxAttempts;
		let lastTransportCause: unknown;

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const startedAt = Date.now();
			let response: Response;
			try {
				response = await doFetch(url, {
					method: input.method,
					headers,
					...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (cause) {
				lastTransportCause = cause;
				const isLast = attempt === maxAttempts - 1;
				const retryInMs = isLast ? undefined : backoffDelayMs(policy, attempt, undefined, random);
				options.onAttempt?.({
					method: input.method,
					path: input.path,
					attempt,
					durationMs: Date.now() - startedAt,
					error: cause,
					...(retryInMs === undefined ? {} : { retryInMs }),
				});
				if (isLast) {
					break;
				}
				await wait(retryInMs ?? 0);
				continue;
			}

			const text = await response.text();
			let payload: unknown = null;
			if (text.length > 0) {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = { raw: text };
				}
			}

			if (response.ok) {
				options.onAttempt?.({
					method: input.method,
					path: input.path,
					attempt,
					status: response.status,
					durationMs: Date.now() - startedAt,
				});
				if (payload === null && input.allowEmptyBody === true) {
					// The schema still runs: a resource that documents an empty success body declares it
					// with a schema that accepts `undefined`, so "empty" stays a typed outcome.
					payload = undefined;
				}
				const parsed = input.schema.safeParse(payload);
				if (!parsed.success) {
					throw new TelnyxResponseShapeError({
						method: input.method,
						path: input.path,
						issues: parsed.error.issues.map(
							(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
						),
					});
				}
				return parsed.data;
			}

			const retryable = isRetryableStatus(response.status);
			const isLast = attempt === maxAttempts - 1;
			// Telnyx sends no `Retry-After`; `x-ratelimit-reset` is the hint it does send. Both are
			// read, the larger wins, and neither is trusted as the whole delay — see `retry.ts`.
			const carrierFloorMs =
				parseRetryAfterMs(response.headers.get("retry-after")) ??
				parseRateLimitResetMs(response.headers.get("x-ratelimit-reset"));
			const retryInMs =
				retryable && !isLast ? backoffDelayMs(policy, attempt, carrierFloorMs, random) : undefined;
			options.onAttempt?.({
				method: input.method,
				path: input.path,
				attempt,
				status: response.status,
				durationMs: Date.now() - startedAt,
				...(retryInMs === undefined ? {} : { retryInMs }),
			});

			if (!retryable || isLast) {
				const requestId = response.headers.get("x-request-id") ?? undefined;
				throw new TelnyxApiError({
					status: response.status,
					errors: readErrors(payload),
					method: input.method,
					path: input.path,
					...(requestId === undefined ? {} : { requestId }),
				});
			}
			await wait(retryInMs ?? 0);
		}

		throw new TelnyxTransportError({
			method: input.method,
			path: input.path,
			attempts: maxAttempts,
			cause: lastTransportCause,
		});
	}

	return { request, baseUrl };
}
