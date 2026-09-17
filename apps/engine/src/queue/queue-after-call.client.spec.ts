import { describe, expect, it } from "bun:test";
import { of, throwError } from "rxjs";
import { QueueAfterCallClient } from "./queue-after-call.client";
import type { ClientProxy } from "@nestjs/microservices";

/**
 * The client side of `rpc.pbx.v1.queue-disposition` and `rpc.pbx.v1.queue-survey`.
 *
 * One invariant underneath every case here, and it is the opposite of the one `*99`'s client
 * keeps: **nothing this file does may reach the caller.** Both reports are made from a detached
 * task on the ARI event socket after the call has ended, so a refusal, an unreadable reply and a
 * broker with no responder all have to resolve rather than throw — the log is the only place the
 * difference is allowed to show up.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000b1";
const AGENT = "0195c0f0-1c2f-7000-8000-0000000000a2";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const QUESTION = "0195c0f0-1c2f-7000-8000-0000000000f1";

function clientReturning(value: unknown): {
	proxy: ClientProxy;
	sent: { subject: string; payload: unknown }[];
} {
	const sent: { subject: string; payload: unknown }[] = [];
	const proxy = {
		send: (subject: string, payload: unknown) => {
			sent.push({ subject, payload });
			return of(value);
		},
	} as unknown as ClientProxy;
	return { proxy, sent };
}

function clientFailing(): { proxy: ClientProxy; sent: string[] } {
	const sent: string[] = [];
	const proxy = {
		send: (subject: string) => {
			sent.push(subject);
			return throwError(() => new Error("no responders available for request"));
		},
	} as unknown as ClientProxy;
	return { proxy, sent };
}

describe("QueueAfterCallClient", () => {
	it("reports the auto-wrap blank on the versioned subject", async () => {
		const { proxy, sent } = clientReturning({ recorded: true });
		await new QueueAfterCallClient(proxy).disposition({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			code: "unset",
			auto: true,
		});

		expect(sent[0]?.subject).toBe("rpc.pbx.v1.queue-disposition");
		expect(sent[0]?.payload).toEqual({
			orgId: ORG,
			queueId: QUEUE,
			agentId: AGENT,
			callId: CALL,
			code: "unset",
			auto: true,
		});
	});

	it("refuses to report a code the distributor is not entitled to name, without asking", async () => {
		const { proxy, sent } = clientReturning({ recorded: true });
		const client = new QueueAfterCallClient(proxy);
		await client.disposition({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			code: "sale",
			auto: false,
		});

		expect(sent).toEqual([]);
		expect(client.stats.failures).toBe(1);
	});

	it("swallows a disposition the responder declined, which is the agent having chosen first", async () => {
		const { proxy } = clientReturning({ recorded: false, reason: "already dispositioned" });
		const client = new QueueAfterCallClient(proxy);
		await client.disposition({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			code: "unset",
			auto: true,
		});

		// Not a failure: the deadline lost the race to a real answer, which is the feature working.
		expect(client.stats.failures).toBe(0);
	});

	it("swallows a broker with no responder on both subjects", async () => {
		const { proxy, sent } = clientFailing();
		const client = new QueueAfterCallClient(proxy);
		await client.disposition({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			code: "unset",
			auto: true,
		});
		await client.surveyAnswered({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			answers: [{ questionId: QUESTION, digit: "5" }],
		});

		expect(sent).toEqual(["rpc.pbx.v1.queue-disposition", "rpc.pbx.v1.queue-survey"]);
		expect(client.stats.failures).toBe(2);
	});

	it("sends every answer in one request", async () => {
		const { proxy, sent } = clientReturning({ recorded: 2 });
		await new QueueAfterCallClient(proxy).surveyAnswered({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			answers: [
				{ questionId: QUESTION, digit: "5" },
				{ questionId: AGENT, digit: "1" },
			],
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]?.subject).toBe("rpc.pbx.v1.queue-survey");
		expect(sent[0]?.payload).toEqual({
			orgId: ORG,
			queueId: QUEUE,
			agentId: AGENT,
			callId: CALL,
			answers: [
				{ questionId: QUESTION, digit: "5" },
				{ questionId: AGENT, digit: "1" },
			],
		});
	});

	it("makes no request for a survey nobody answered", async () => {
		const { proxy, sent } = clientReturning({ recorded: 0 });
		await new QueueAfterCallClient(proxy).surveyAnswered({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			answers: [],
		});

		expect(sent).toEqual([]);
	});

	it("swallows a reply this release cannot read", async () => {
		const { proxy } = clientReturning({ recorded: "two" });
		const client = new QueueAfterCallClient(proxy);
		await client.surveyAnswered({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			agentId: AGENT,
			answers: [{ questionId: QUESTION, digit: "3" }],
		});

		expect(client.stats.failures).toBe(1);
	});
});
