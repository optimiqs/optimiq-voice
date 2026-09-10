import { describe, expect, it } from "bun:test";
import { subjectFor } from "@optimiq-voice/events";
import { CallControlService } from "./call-control.service";
import type { EngineEnv } from "../config/engine-env";
import type { CallControlHandler, CallControlOutcome } from "./call-control.service";
import type { JetStreamService } from "./jetstream.service";
import type { CallControlRequest, CallControlResponse } from "@optimiq-voice/events";

/**
 * The transport half of `rpc.engine.v1.call-control.<instanceToken>`.
 *
 * Same property as `session-verb.service.spec.ts` proves and for a sharper reason: **every path
 * answers**. The thing waiting is an HTTP request with an agent behind it who is about to read a
 * card number aloud, and a responder that declines to reply is indistinguishable from an engine
 * that has died. The RESOLUTION logic — which leg, whose organization, is anything recording — is
 * `calls/channel-orchestrator.spec.ts`; this file is the wire.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

function request(overrides: Partial<CallControlRequest> = {}): CallControlRequest {
	return { orgId: ORG, callId: "call-1", verb: "pauseRecord", ...overrides };
}

/** A NATS connection made of two queues, exactly as in `session-verb.service.spec.ts`. */
function fakeConnection() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const replies: CallControlResponse[] = [];
	const subscribed: { subject: string; queue?: string }[] = [];
	const pending: { data: Uint8Array; reply?: string }[] = [];
	let wake: (() => void) | undefined;

	async function* messages(): AsyncGenerator<{
		data: Uint8Array;
		reply?: string;
		respond: (data: Uint8Array) => void;
	}> {
		for (;;) {
			const next = pending.shift();
			if (next === undefined) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			yield {
				data: next.data,
				...(next.reply === undefined ? {} : { reply: next.reply }),
				respond: (data: Uint8Array) => {
					replies.push(JSON.parse(decoder.decode(data)) as CallControlResponse);
				},
			};
		}
	}

	const iterator = messages();
	const connection = {
		subscribe: (subject: string, options?: { queue?: string }) => {
			subscribed.push({
				subject,
				...(options?.queue === undefined ? {} : { queue: options.queue }),
			});
			return { [Symbol.asyncIterator]: () => iterator, unsubscribe: () => undefined };
		},
		isClosed: () => false,
	};

	return {
		connection,
		replies,
		subscribed,
		deliver: async (
			bytes: string,
			options: { readonly reply?: string } = { reply: "_INBOX.test" },
		): Promise<void> => {
			pending.push({
				data: encoder.encode(bytes),
				...(options.reply === undefined ? {} : { reply: options.reply }),
			});
			wake?.();
			wake = undefined;
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
		},
	};
}

function handler(
	outcome: CallControlOutcome | "throws" = {
		ok: true,
		verb: "pauseRecord",
		legId: "leg-1",
		recording: true,
		paused: true,
	},
): { readonly handler: CallControlHandler; readonly requests: CallControlRequest[] } {
	const requests: CallControlRequest[] = [];
	return {
		requests,
		handler: {
			control: async (received) => {
				requests.push(received);
				if (outcome === "throws") {
					throw new Error("the runtime is on fire");
				}
				return outcome;
			},
		},
	};
}

function service(fake: ReturnType<typeof fakeConnection> | undefined, instanceId = "engine-1") {
	return new CallControlService(
		{ ENGINE_INSTANCE_ID: instanceId } as EngineEnv,
		{
			rawConnection: fake?.connection,
		} as unknown as JetStreamService,
	);
}

describe("CallControlService", () => {
	it("subscribes to its own instance's subject, with no queue group", () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.onApplicationBootstrap();

		expect(responder.subject).toBe(subjectFor.engineCallControlRpc("engine-1"));
		expect(fake.subscribed).toEqual([{ subject: "rpc.engine.v1.call-control.engine-1" }]);
		expect(responder.stats.listening).toBe(true);
	});

	it("does not listen when the engine has no broker connection", () => {
		const responder = service(undefined);
		responder.onApplicationBootstrap();
		expect(responder.stats.listening).toBe(false);
	});

	it("is idempotent, so a second bootstrap does not open a second subscription", () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.onApplicationBootstrap();
		responder.onApplicationBootstrap();
		expect(fake.subscribed).toHaveLength(1);
	});

	it("stamps its own instance on the reply, so the handler cannot attribute it elsewhere", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.attach(
			handler({
				ok: true,
				verb: "pauseRecord",
				instanceId: "someone-else",
			} as CallControlOutcome).handler,
		);
		responder.onApplicationBootstrap();
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({
			ok: true,
			verb: "pauseRecord",
			instanceId: "engine-1",
		});
		expect(responder.stats).toMatchObject({ served: 1, executed: 1 });
	});

	it("carries a request with no legId through untouched — the common case", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		const attached = handler();
		responder.attach(attached.handler);
		responder.onApplicationBootstrap();

		await fake.deliver(JSON.stringify(request()));

		// The control plane has the CALL, not the leg. Nothing on the wire may invent one.
		expect(attached.requests[0]).toMatchObject({ callId: "call-1", verb: "pauseRecord" });
		expect(attached.requests[0]?.legId).toBeUndefined();
	});

	it("refuses a verb outside the three recording ones at the wire", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		const attached = handler();
		responder.attach(attached.handler);
		responder.onApplicationBootstrap();

		await fake.deliver(JSON.stringify({ orgId: ORG, callId: "call-1", verb: "hangup" }));

		// The schema is the allowlist, and it is what stops this becoming a general remote control.
		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "bad_request" });
		expect(attached.requests).toEqual([]);
	});

	it("answers unparseable bytes with bad_request and keeps serving", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		const attached = handler();
		responder.attach(attached.handler);
		responder.onApplicationBootstrap();

		await fake.deliver("{not json");
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "bad_request" });
		expect(fake.replies[1]).toMatchObject({ ok: true });
		expect(attached.requests).toHaveLength(1);
	});

	it("answers internal when nothing has attached a handler yet", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.onApplicationBootstrap();
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal" });
	});

	it("answers internal when the handler throws, and keeps serving", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.attach(handler("throws").handler);
		responder.onApplicationBootstrap();
		await fake.deliver(JSON.stringify(request()));
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toHaveLength(2);
		expect(fake.replies[1]).toMatchObject({ ok: false, reason: "internal" });
	});

	it("refuses while draining rather than pausing a recording it is about to abandon", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		const attached = handler();
		responder.attach(attached.handler);
		responder.onApplicationBootstrap();
		responder.onApplicationShutdown();
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "shutting-down" });
		expect(attached.requests).toEqual([]);
	});

	it("does not count a request with no reply subject as served", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.attach(handler().handler);
		responder.onApplicationBootstrap();
		await fake.deliver(JSON.stringify(request()), {});

		expect(fake.replies).toEqual([]);
		expect(responder.stats.served).toBe(0);
	});
});
