import { describe, expect, it } from "bun:test";
import { subjectFor } from "@optimiq-voice/events";
import { SessionVerbService } from "./session-verb.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type { SessionVerbHandler, SessionVerbOutcome } from "./session-verb.service";
import type { SessionVerbRequest, SessionVerbResponse } from "@optimiq-voice/events";

/**
 * The transport half of `rpc.engine.v1.session-verb.<instanceToken>`.
 *
 * The property worth proving here and nowhere else is the same one the originate responder's spec
 * states, and it matters more on this subject: **every path answers**. The caller is a WebSocket
 * with an integration on the other end of it and a caller on the line, and a responder that
 * declines to reply to a request it dislikes is indistinguishable from an engine that has died —
 * which needs a completely different thing done about it. The verb LOGIC is
 * `session/application-sessions.spec.ts`; this file is the wire.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

function request(overrides: Partial<SessionVerbRequest> = {}): SessionVerbRequest {
	return {
		orgId: ORG,
		sessionId: "sess-1",
		callId: "call-1",
		legId: "leg-1",
		verb: "answer",
		...overrides,
	};
}

/** A NATS connection made of two queues, exactly as in `originate.service.spec.ts`. */
function fakeConnection() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const replies: SessionVerbResponse[] = [];
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
					replies.push(JSON.parse(decoder.decode(data)) as SessionVerbResponse);
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
	outcome: SessionVerbOutcome | "throws" = { ok: true, verb: "answer", endReason: "completed" },
): { readonly handler: SessionVerbHandler; readonly requests: SessionVerbRequest[] } {
	const requests: SessionVerbRequest[] = [];
	return {
		requests,
		handler: {
			execute: async (received) => {
				requests.push(received);
				if (outcome === "throws") {
					throw new Error("the executor is on fire");
				}
				return outcome;
			},
		},
	};
}

function service(fake: ReturnType<typeof fakeConnection> | undefined, instanceId = "engine-1") {
	return new SessionVerbService(
		{ ENGINE_INSTANCE_ID: instanceId } as EngineEnv,
		{
			rawConnection: fake?.connection,
		} as unknown as JetStreamService,
	);
}

describe("SessionVerbService", () => {
	/**
	 * Instance-addressed and NOT queue-grouped. A queue group here would hand a verb to whichever
	 * engine answered first, and on a fleet of eight that is the right one once.
	 */
	it("subscribes to its own instance's subject, with no queue group", () => {
		const fake = fakeConnection();
		const responder = service(fake);
		responder.onApplicationBootstrap();

		expect(responder.subject).toBe(subjectFor.engineSessionVerbRpc("engine-1"));
		expect(fake.subscribed).toEqual([{ subject: "rpc.engine.v1.session-verb.engine-1" }]);
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
				verb: "answer",
				endReason: "completed",
				instanceId: "someone-else",
			} as SessionVerbOutcome).handler,
		);
		responder.onApplicationBootstrap();
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: true, verb: "answer", instanceId: "engine-1" });
		expect(responder.stats).toMatchObject({ served: 1, executed: 1 });
	});

	/**
	 * Bytes that are not the contract are answered, not dropped — and the loop survives, which is the
	 * half that matters: one malformed frame from one integration must not stop this instance
	 * serving every other call it is holding.
	 */
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

	it("refuses while draining rather than half-running a verb on a closing channel", async () => {
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

	/**
	 * The one behaviour this responder does NOT share with its siblings: verbs are served
	 * concurrently. A `gather` waits for a person to finish dialling, and serving these in sequence
	 * would let one caller's digits block every other call this instance is holding.
	 */
	it("serves verbs concurrently, so a slow gather does not block another call", async () => {
		const fake = fakeConnection();
		const responder = service(fake);
		let release: (() => void) | undefined;
		let started = 0;
		responder.attach({
			execute: async (received) => {
				started += 1;
				if (received.verb === "gather") {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				return { ok: true, verb: received.verb, endReason: "completed" };
			},
		});
		responder.onApplicationBootstrap();

		await fake.deliver(JSON.stringify(request({ verb: "gather" })));
		await fake.deliver(JSON.stringify(request({ verb: "answer", sessionId: "sess-2" })));

		// The second verb ran and answered while the first was still waiting for digits.
		expect(started).toBe(2);
		expect(fake.replies).toHaveLength(1);
		expect(fake.replies[0]).toMatchObject({ verb: "answer" });

		release?.();
		for (let tick = 0; tick < 20; tick += 1) {
			await Promise.resolve();
		}
		expect(fake.replies).toHaveLength(2);
	});
});
