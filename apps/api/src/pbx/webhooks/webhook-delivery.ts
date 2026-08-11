import {
	signWebhookBody,
	WEBHOOK_ATTEMPT_HEADER,
	WEBHOOK_EVENT_HEADER,
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_SUBSCRIPTION_HEADER,
} from "./webhook-signature";

/**
 * One HTTP delivery: the request this platform makes, and what it concludes from the answer.
 *
 * Separated from the dispatcher so the policy — which statuses retry, what the backoff is, what the
 * request looks like on the wire — is testable without a broker, a database or a socket. The
 * dispatcher owns the queue and the bookkeeping; this owns the attempt.
 */

/** The transport, injected so a spec is not a web server. Matches the shape of `fetch`. */
export type WebhookFetch = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body: string;
		readonly signal: AbortSignal;
		readonly redirect: "error";
	},
) => Promise<{ readonly status: number }>;

export interface WebhookDeliveryPolicy {
	readonly timeoutMs: number;
	readonly maxAttempts: number;
	readonly retryBaseMs: number;
	readonly maxBackoffMs: number;
}

export interface WebhookDeliveryTarget {
	readonly subscriptionId: string;
	readonly url: string;
	readonly secret: string;
}

export type WebhookDeliveryOutcome =
	| { readonly kind: "delivered"; readonly attempts: number; readonly status: number }
	| { readonly kind: "failed"; readonly attempts: number; readonly reason: string };

/**
 * Which HTTP answers are worth trying again.
 *
 * `408`, `429` and every `5xx` are the receiver saying "not now": a restart, a rate limit, an
 * overloaded upstream. Everything else in the 4xx range is the receiver saying "not this" — a 401
 * from a rotated shared secret, a 404 from a decommissioned path, a 400 from a body it dislikes —
 * and repeating the identical bytes twice more can only produce the identical answer twice more.
 *
 * `3xx` is deliberately NOT followed and NOT retried; see {@link deliverWebhook} for why.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/** `base * 2^(n-1)`, capped. A zero base means no wait, which is what the specs configure. */
export function webhookBackoffMs(attempt: number, policy: WebhookDeliveryPolicy): number {
	return Math.min(policy.retryBaseMs * 2 ** (attempt - 1), policy.maxBackoffMs);
}

/**
 * POSTs one event to one endpoint, with bounded retries. NEVER throws.
 *
 * ## The request is deliberately unremarkable
 *
 * `POST`, `application/json`, four headers and a body. In particular:
 *
 * - **Redirects are refused, not followed.** `redirect: "error"` is the one line in this file that
 *   is a security control rather than a convenience. A configured URL is what an administrator
 *   reviewed; a redirect is a destination the RECEIVER chooses at request time, which turns every
 *   webhook into a request this platform makes to an address nobody approved — the SSRF shape the
 *   DTO's note says cannot be closed at write time. It is closed here.
 * - **The response body is never read.** Nothing in the contract is carried back, and reading an
 *   unbounded body from a stranger is a memory profile decided by somebody else.
 * - **The timeout covers the whole attempt** via `AbortSignal.timeout`, so a receiver that accepts
 *   the connection and then goes quiet costs one timeout rather than a held socket.
 *
 * ## Failures are strings, not exceptions
 *
 * The reason lands in `webhook_subscription.last_failure_reason`, which is the column an
 * administrator reads when the endpoint stops working, so it has to be one line and it has to be
 * about the endpoint — a status, a timeout, a DNS failure. Never a body, which could be anything at
 * all, and never a stack.
 */
export async function deliverWebhook(
	fetchImpl: WebhookFetch,
	target: WebhookDeliveryTarget,
	eventType: string,
	body: string,
	policy: WebhookDeliveryPolicy,
	nowMs: () => number = Date.now,
	sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<WebhookDeliveryOutcome> {
	let lastReason = "no attempt was made";
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		const timestampSeconds = Math.floor(nowMs() / 1000);
		try {
			const response = await fetchImpl(target.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(target.secret, body, timestampSeconds),
					[WEBHOOK_EVENT_HEADER]: eventType,
					[WEBHOOK_SUBSCRIPTION_HEADER]: target.subscriptionId,
					[WEBHOOK_ATTEMPT_HEADER]: String(attempt),
				},
				body,
				signal: AbortSignal.timeout(policy.timeoutMs),
				redirect: "error",
			});

			if (response.status >= 200 && response.status < 300) {
				return { kind: "delivered", attempts: attempt, status: response.status };
			}
			lastReason = `HTTP ${response.status}`;
			if (!isRetryableStatus(response.status)) {
				return { kind: "failed", attempts: attempt, reason: lastReason };
			}
		} catch (error) {
			// A timeout, a DNS failure, a refused connection, or a redirect the transport rejected.
			// All transient-shaped except the last, and the last is rare enough that spending two more
			// attempts on it is cheaper than a classifier that gets it wrong.
			lastReason = describeTransportFailure(error);
		}

		if (attempt < policy.maxAttempts) {
			await sleep(webhookBackoffMs(attempt, policy));
		}
	}
	return { kind: "failed", attempts: policy.maxAttempts, reason: lastReason };
}

/** One line, capped, and never the response body. See the note on failures above. */
function describeTransportFailure(error: unknown): string {
	if (error instanceof Error) {
		const name =
			error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.name;
		return `${name}: ${error.message}`.slice(0, 256);
	}
	return String(error).slice(0, 256);
}

async function defaultSleep(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});
}
