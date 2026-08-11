import { HttpException } from "@nestjs/common";
import { expect } from "chai";
import { originateCallDto } from "../../src/pbx/calls/calls.dto";
import { originateRefusalException } from "../../src/pbx/calls/calls.errors";
import { OriginateRateLimiter } from "../../src/pbx/calls/originate-rate-limit";
import { interpretOriginateReply } from "../../src/pbx/calls/originate-reply";
import type { OriginateRefusalReason } from "@optimiq-voice/events/schemas";

/**
 * `POST /api/v1/calls`, minus the socket.
 *
 * Three things are worth proving here. That every refusal in the engine's vocabulary lands on a
 * status a client can act on — a dial button has to tell "fix your configuration" apart from "try
 * again" apart from "not your fault". That a reply which is not the contract fails as a DEPLOYMENT
 * problem rather than as the caller's. And that the rate limit counts the tenant, because the thing
 * it bounds is money.
 */

const CONTEXT = { from: "1001", to: "+15551230000" };

function reply(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function statusOf(run: () => unknown): number {
	try {
		run();
	} catch (error) {
		if (error instanceof HttpException) {
			return error.getStatus();
		}
		throw error;
	}
	throw new Error("expected the call to throw");
}

describe("originate refusal mapping", () => {
	const EXPECTED: Readonly<Record<OriginateRefusalReason, number>> = {
		bad_request: 500,
		unknown_extension: 404,
		extension_offline: 409,
		invalid_target: 422,
		capacity: 503,
		not_supported: 501,
		shutting_down: 503,
		internal: 500,
	};

	it("maps every reason in the contract, and only to a status a caller can act on", () => {
		for (const [reason, status] of Object.entries(EXPECTED) as [OriginateRefusalReason, number][]) {
			expect(
				statusOf(() => {
					throw originateRefusalException(reason, "because", CONTEXT);
				}),
				reason,
			).to.equal(status);
		}
	});

	it("carries the reason and the request in the body, so a client switches on a string", () => {
		const exception = originateRefusalException("unknown_extension", "no extension 1001", {
			...CONTEXT,
			instanceId: "engine-1",
		});
		const body = exception.getResponse() as Record<string, unknown>;
		expect(body.code).to.equal("CALL_ORIGINATE_REFUSED");
		expect(body.reason).to.equal("unknown_extension");
		expect(body.from).to.equal("1001");
		expect(body.to).to.equal("+15551230000");
		expect(body.instanceId).to.equal("engine-1");
		expect(body.detail).to.equal("no extension 1001");
	});
});

describe("reading the engine's reply", () => {
	it("returns the engine's own call and leg ids", () => {
		const accepted = interpretOriginateReply(
			reply({
				ok: true,
				originateId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6",
				callId: "019fd3c2-2222-76be-a6b3-b0f1914e39b6",
				legId: "019fd3c2-3333-76be-a6b3-b0f1914e39b6",
				instanceId: "engine-1",
			}),
			CONTEXT,
		);
		expect(accepted.callId).to.equal("019fd3c2-2222-76be-a6b3-b0f1914e39b6");
		expect(accepted.legId).to.equal("019fd3c2-3333-76be-a6b3-b0f1914e39b6");
		expect(accepted.instanceId).to.equal("engine-1");
	});

	it("throws the mapped refusal for a refusal", () => {
		expect(
			statusOf(() =>
				interpretOriginateReply(
					reply({ ok: false, originateId: "x", reason: "extension_offline" }),
					CONTEXT,
				),
			),
		).to.equal(409);
	});

	it("treats an unreadable reply as the deployment's problem, not the caller's", () => {
		expect(
			statusOf(() => interpretOriginateReply(new TextEncoder().encode("{not json"), CONTEXT)),
		).to.equal(503);
		expect(
			statusOf(() => interpretOriginateReply(reply({ ok: true, originateId: "x" }), CONTEXT)),
		).to.equal(503);
	});

	it("refuses a reply with no reason as `internal` rather than inventing one", () => {
		expect(
			statusOf(() => interpretOriginateReply(reply({ ok: false, originateId: "x" }), CONTEXT)),
		).to.equal(500);
	});
});

describe("the originate rate limit", () => {
	it("counts the ORGANIZATION, because the tenant is the billing boundary", () => {
		const limiter = new OriginateRateLimiter(2);
		const now = 1_000;

		expect(limiter.consume("org-a", now).allowed).to.equal(true);
		expect(limiter.consume("org-a", now).allowed).to.equal(true);
		expect(limiter.consume("org-a", now).allowed).to.equal(false);
		// A second tenant is unaffected by the first one's spend.
		expect(limiter.consume("org-b", now).allowed).to.equal(true);
	});

	it("resets when the window rolls, and reports how long that is", () => {
		const limiter = new OriginateRateLimiter(1);
		const now = 1_000;

		limiter.consume("org-a", now);
		const refused = limiter.consume("org-a", now + 30_000);
		expect(refused.allowed).to.equal(false);
		expect(refused.retryAfterSeconds).to.equal(30);

		expect(limiter.consume("org-a", now + 61_000).allowed).to.equal(true);
	});

	it("is disabled by a limit of zero, for a deployment that bounds this elsewhere", () => {
		const limiter = new OriginateRateLimiter(0);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			expect(limiter.consume("org-a").allowed).to.equal(true);
		}
		expect(limiter.size).to.equal(0);
	});
});

describe("the originate DTO", () => {
	it("accepts the two fields a dial button has", () => {
		expect(originateCallDto.safeParse({ from: "1001", to: "+15551230000" }).success).to.equal(true);
	});

	it("rejects an unknown key, a tenant the caller tried to choose most of all", () => {
		expect(
			originateCallDto.safeParse({
				from: "1001",
				to: "1002",
				organizationId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6",
			}).success,
		).to.equal(false);
	});

	it("rejects a `from` that is not an extension number", () => {
		expect(originateCallDto.safeParse({ from: "sip:1001@evil", to: "1002" }).success).to.equal(
			false,
		);
		expect(originateCallDto.safeParse({ from: "", to: "1002" }).success).to.equal(false);
	});

	it("bounds the ring timeout, so one request cannot hold a channel indefinitely", () => {
		expect(
			originateCallDto.safeParse({ from: "1001", to: "1002", ringTimeoutSeconds: 45 }).success,
		).to.equal(true);
		expect(
			originateCallDto.safeParse({ from: "1001", to: "1002", ringTimeoutSeconds: 1 }).success,
		).to.equal(false);
		expect(
			originateCallDto.safeParse({ from: "1001", to: "1002", ringTimeoutSeconds: 3_600 }).success,
		).to.equal(false);
	});
});
