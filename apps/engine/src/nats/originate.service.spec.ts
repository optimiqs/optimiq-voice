import { describe, expect, it } from "bun:test";
import { subjectFor } from "@optimiq-voice/events";
import { OriginateService } from "./originate.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type { OriginateCallPath, OriginatePlacement } from "./originate.service";
import type { OriginateRequest } from "@optimiq-voice/events";

/**
 * The transport half of `rpc.engine.v1.originate`, with a fake connection and a fake call path.
 *
 * What is worth proving here and nowhere else: that every path ANSWERS. The caller is a person
 * holding a mouse and an HTTP request that is going to time out in five seconds, so a responder that
 * declines to reply on a request it dislikes is indistinguishable from an engine that has died —
 * and the two need completely different things done about them. The dial-plan half is
 * `calls/originate-plan.spec.ts`; the media half is the orchestrator's.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const ORIGINATE_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";

function request(overrides: Partial<OriginateRequest> = {}): OriginateRequest {
	return {
		orgId: ORG,
		originateId: ORIGINATE_ID,
		fromExtension: "1001",
		to: "+15551230000",
		...overrides,
	};
}

/** A NATS connection made of two queues, exactly as in `sip-transfer.service.spec.ts`. */
function fakeConnection() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const replies: unknown[] = [];
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
					replies.push(JSON.parse(decoder.decode(data)) as unknown);
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
		/**
		 * Delivers one raw request and settles the responder's answer.
		 *
		 * `options` rather than an optional `reply` argument, because passing `undefined` to an
		 * argument with a default gets the default — which is exactly the case the no-reply test needs
		 * to express.
		 */
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

function callPath(
	placement: OriginatePlacement | "throws" = {
		kind: "placed",
		callId: "call-1",
		legId: "leg-1",
		endpoint: "PJSIP/1001",
	},
): { readonly path: OriginateCallPath; readonly requests: OriginateRequest[] } {
	const requests: OriginateRequest[] = [];
	return {
		requests,
		path: {
			place: async (received) => {
				requests.push(received);
				if (placement === "throws") {
					throw new Error("the media server is on fire");
				}
				return placement;
			},
		},
	};
}

function service(
	fake: ReturnType<typeof fakeConnection>,
	path?: OriginateCallPath,
): OriginateService {
	const jetstream = { rawConnection: fake.connection } as unknown as JetStreamService;
	const built = new OriginateService({ ENGINE_INSTANCE_ID: "engine-1" } as EngineEnv, jetstream);
	if (path !== undefined) {
		built.attach(path);
	}
	built.onApplicationBootstrap();
	return built;
}

describe("the originate subscription", () => {
	it("answers on the flat contract subject, in a queue group so exactly one engine places the call", () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		expect(built.subject).toBe(subjectFor.engineOriginateRpc());
		expect(fake.subscribed).toEqual([
			{ subject: "rpc.engine.v1.originate", queue: "optimiq-engine-originate" },
		]);
		expect(built.stats.listening).toBe(true);
	});

	it("does not subscribe when the engine has no broker connection", () => {
		const jetstream = { rawConnection: undefined } as unknown as JetStreamService;
		const built = new OriginateService({ ENGINE_INSTANCE_ID: "engine-1" } as EngineEnv, jetstream);
		built.onApplicationBootstrap();
		expect(built.stats.listening).toBe(false);
	});

	it("subscribes once, however many times Nest bootstraps it", () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);
		built.onApplicationBootstrap();
		expect(fake.subscribed).toHaveLength(1);
	});
});

describe("answering an originate", () => {
	it("replies with the engine's own call and leg ids, never the caller's handle", async () => {
		const fake = fakeConnection();
		const path = callPath();
		const built = service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toEqual([
			{
				ok: true,
				originateId: ORIGINATE_ID,
				instanceId: "engine-1",
				callId: "call-1",
				legId: "leg-1",
				endpoint: "PJSIP/1001",
			},
		]);
		expect(built.stats.placed).toBe(1);
		expect(path.requests[0]?.to).toBe("+15551230000");
	});

	it("refuses bytes that are not the contract, rather than letting the loop die on them", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		await fake.deliver("{not json");
		await fake.deliver(JSON.stringify({ orgId: ORG }));

		expect(fake.replies).toHaveLength(2);
		for (const reply of fake.replies as { ok: boolean; reason: string }[]) {
			expect(reply.ok).toBe(false);
			expect(reply.reason).toBe("bad_request");
		}
		// The loop survived both and is still serving.
		expect(built.stats.served).toBe(2);
	});

	it("passes the call path's refusal through verbatim, so the API can map it to a status", async () => {
		const fake = fakeConnection();
		const built = service(
			fake,
			callPath({ kind: "refused", reason: "unknown_extension", error: "no extension 1001" }).path,
		);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toEqual([
			{
				ok: false,
				originateId: ORIGINATE_ID,
				instanceId: "engine-1",
				reason: "unknown_extension",
				error: "no extension 1001",
			},
		]);
		expect(built.stats.placed).toBe(0);
	});

	it("refuses `internal` rather than hanging when no call path is attached yet", async () => {
		const fake = fakeConnection();
		service(fake);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toHaveLength(1);
		expect((fake.replies[0] as { reason: string }).reason).toBe("internal");
	});

	it("turns a call path that throws into a refusal and keeps serving", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath("throws").path);

		await fake.deliver(JSON.stringify(request()));
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toHaveLength(2);
		expect((fake.replies[0] as { reason: string }).reason).toBe("internal");
		expect(built.stats.served).toBe(2);
	});

	it("refuses `shutting_down` once draining, so the retry lands on another instance", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);
		built.onApplicationShutdown();

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toHaveLength(1);
		expect((fake.replies[0] as { reason: string }).reason).toBe("shutting_down");
		expect(built.stats.listening).toBe(false);
	});

	it("does not count a request with no reply subject as served", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		await fake.deliver(JSON.stringify(request()), {});

		expect(fake.replies).toHaveLength(0);
		expect(built.stats.served).toBe(0);
	});
});
