import { expect } from "chai";
import {
	deliverWebhook,
	isRetryableStatus,
	webhookBackoffMs,
	type WebhookFetch,
} from "../../src/pbx/webhooks/webhook-delivery";
import { verifyWebhookSignature } from "../../src/pbx/webhooks/webhook-signature";

/**
 * One delivery attempt and the retry policy around it, with the transport faked.
 *
 * What matters here is what the platform DOES to a stranger's endpoint and what it CONCLUDES from
 * the answer: a bounded number of attempts, a refusal to follow redirects, a signature the receiver
 * can verify, and a one-line reason that never carries a response body.
 */

const POLICY = { timeoutMs: 1_000, maxAttempts: 3, retryBaseMs: 0, maxBackoffMs: 0 };
const TARGET = {
	subscriptionId: "0195c0f0-1c2f-7000-8000-0000000000a1",
	url: "https://example.test/hook",
	secret: "whsec_test",
};
const BODY = JSON.stringify({ id: "evt-1", type: "channel.answered" });

interface Recorded {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly redirect: string;
}

function recordingFetch(answers: (number | Error)[]): {
	readonly fetchImpl: WebhookFetch;
	readonly calls: Recorded[];
} {
	const calls: Recorded[] = [];
	let index = 0;
	const fetchImpl: WebhookFetch = async (url, init) => {
		calls.push({
			url,
			method: init.method,
			headers: init.headers,
			body: init.body,
			redirect: init.redirect,
		});
		const answer = answers[Math.min(index, answers.length - 1)];
		index += 1;
		if (answer instanceof Error) {
			throw answer;
		}
		return { status: answer };
	};
	return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe("webhook delivery", () => {
	it("POSTs a signed body the receiver can verify, and refuses redirects", async () => {
		const { fetchImpl, calls } = recordingFetch([200]);

		const outcome = await deliverWebhook(
			fetchImpl,
			TARGET,
			"channel.answered",
			BODY,
			POLICY,
			() => 1_786_185_600_000,
			noSleep,
		);

		expect(outcome).to.deep.equal({ kind: "delivered", attempts: 1, status: 200 });
		const call = calls[0];
		expect(call?.method).to.equal("POST");
		expect(call?.url).to.equal(TARGET.url);
		expect(call?.body).to.equal(BODY);
		// The one line in the delivery path that is a security control, not a convenience.
		expect(call?.redirect).to.equal("error");
		expect(call?.headers["x-optimiq-event"]).to.equal("channel.answered");
		expect(call?.headers["x-optimiq-subscription"]).to.equal(TARGET.subscriptionId);
		expect(call?.headers["x-optimiq-attempt"]).to.equal("1");
		expect(
			verifyWebhookSignature(
				TARGET.secret,
				BODY,
				call?.headers["x-optimiq-signature"] ?? "",
				1_786_185_600,
			),
		).to.equal(true);
	});

	it("retries a 500 up to the attempt budget and reports the last reason", async () => {
		const { fetchImpl, calls } = recordingFetch([503]);

		const outcome = await deliverWebhook(fetchImpl, TARGET, "e", BODY, POLICY, Date.now, noSleep);

		expect(calls).to.have.length(3);
		expect(outcome).to.deep.equal({ kind: "failed", attempts: 3, reason: "HTTP 503" });
		// The attempt header counts up, so a receiver can dedupe on it.
		expect(calls.map((call) => call.headers["x-optimiq-attempt"])).to.deep.equal(["1", "2", "3"]);
	});

	it("stops immediately on a 4xx the receiver will answer the same way forever", async () => {
		const { fetchImpl, calls } = recordingFetch([404]);

		const outcome = await deliverWebhook(fetchImpl, TARGET, "e", BODY, POLICY, Date.now, noSleep);

		expect(calls).to.have.length(1);
		expect(outcome).to.deep.equal({ kind: "failed", attempts: 1, reason: "HTTP 404" });
	});

	it("succeeds on a later attempt and reports how many it took", async () => {
		const { fetchImpl, calls } = recordingFetch([500, 200]);

		const outcome = await deliverWebhook(fetchImpl, TARGET, "e", BODY, POLICY, Date.now, noSleep);

		expect(calls).to.have.length(2);
		expect(outcome).to.deep.equal({ kind: "delivered", attempts: 2, status: 200 });
	});

	it("turns a transport failure into one line that is not a stack and not a body", async () => {
		const timeout = new Error("The operation was aborted due to timeout");
		timeout.name = "TimeoutError";
		const { fetchImpl } = recordingFetch([timeout]);

		const outcome = await deliverWebhook(fetchImpl, TARGET, "e", BODY, POLICY, Date.now, noSleep);

		expect(outcome.kind).to.equal("failed");
		expect(outcome.kind === "failed" && outcome.reason).to.contain("timeout");
		expect(outcome.kind === "failed" && outcome.reason.length).to.be.lessThan(300);
	});

	it("classifies statuses the way a receiver means them", () => {
		for (const status of [408, 429, 500, 502, 503, 504]) {
			expect(isRetryableStatus(status), String(status)).to.equal(true);
		}
		for (const status of [400, 401, 403, 404, 410, 422, 301, 302]) {
			expect(isRetryableStatus(status), String(status)).to.equal(false);
		}
	});

	it("doubles the backoff and caps it", () => {
		const policy = { timeoutMs: 1, maxAttempts: 5, retryBaseMs: 1_000, maxBackoffMs: 3_000 };
		expect(webhookBackoffMs(1, policy)).to.equal(1_000);
		expect(webhookBackoffMs(2, policy)).to.equal(2_000);
		expect(webhookBackoffMs(3, policy)).to.equal(3_000);
		expect(webhookBackoffMs(9, policy)).to.equal(3_000);
	});
});
