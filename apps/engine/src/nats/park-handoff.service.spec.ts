import { describe, expect, it } from "bun:test";
import { subjectFor } from "@optimiq-voice/events";
import { ParkHandoffError } from "../calls/park-handoff";
import { ParkHandoffService } from "./park-handoff.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type { ParkHandoffRequest, ParkHandoffResponse } from "@optimiq-voice/events";

/**
 * The transport half of `rpc.engine.v1.park-handoff`, with a fake connection.
 *
 * What is worth proving here is exactly what `call-control.spec.ts` cannot: that the bytes on the
 * wire ARE the contract. Every one of these assertions would still pass if the handler logic were
 * wrong, and every one of them would fail if somebody reached for a NestJS `ClientProxy` — which is
 * the mistake this whole file exists to make impossible to ship quietly.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const LOT_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";

function request(overrides: Partial<ParkHandoffRequest> = {}): ParkHandoffRequest {
	return {
		orgId: ORG,
		parkLotId: LOT_ID,
		slot: 401,
		mediaChannelId: "c",
		retrieverInstanceId: "engine-2",
		retrieverMediaChannelId: "r",
		retrieverLegId: "leg-r",
		bridgeId: "bridge-1",
		...overrides,
	};
}

interface Sent {
	readonly subject: string;
	readonly payload: unknown;
}

/**
 * A NATS connection made of two queues.
 *
 * `subscribe` yields whatever a spec delivers, and each delivered message records what was sent
 * back — which is the only way to see the reply frame, because the responder never returns it.
 */
function fakeConnection(
	options: { readonly reply?: unknown; readonly requestThrows?: boolean } = {},
) {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const sent: Sent[] = [];
	const replies: unknown[] = [];
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
		subscribe: (_subject: string) => ({
			[Symbol.asyncIterator]: () => iterator,
			unsubscribe: () => undefined,
		}),
		request: async (subject: string, data: Uint8Array) => {
			sent.push({ subject, payload: JSON.parse(decoder.decode(data)) as unknown });
			if (options.requestThrows === true) {
				throw new Error("timeout");
			}
			return { data: encoder.encode(JSON.stringify(options.reply)) };
		},
		isClosed: () => false,
	};

	return {
		connection,
		sent,
		replies,
		/** Delivers one raw request and settles the responder's answer. */
		deliver: async (bytes: string): Promise<void> => {
			pending.push({ data: encoder.encode(bytes), reply: "_INBOX.test" });
			wake?.();
			wake = undefined;
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
		},
	};
}

function service(
	fake: ReturnType<typeof fakeConnection>,
	options: {
		readonly instanceId?: string;
		readonly configured?: boolean;
		readonly handler?: (request: ParkHandoffRequest) => Promise<ParkHandoffResponse>;
	} = {},
): ParkHandoffService {
	const jetstream = {
		rawConnection: fake.connection,
		parkClaims: { isConfigured: options.configured ?? true },
	} as unknown as JetStreamService;
	const built = new ParkHandoffService(
		{ ENGINE_INSTANCE_ID: options.instanceId ?? "engine-1" } as EngineEnv,
		jetstream,
	);
	if (options.handler !== undefined) {
		built.setHandler(options.handler);
	}
	return built;
}

describe("the park-handoff subject", () => {
	it("is this instance's own, so a request reaches the process holding the call", () => {
		const fake = fakeConnection();
		expect(service(fake, { instanceId: "engine-7" }).subject).toBe(
			subjectFor.engineParkHandoffRpc("engine-7"),
		);
	});

	it("does not subscribe at all when park claims are local to this process", () => {
		const fake = fakeConnection();
		const built = service(fake, { configured: false });
		built.onApplicationBootstrap();
		expect(built.stats.listening).toBe(false);
	});
});

describe("answering a handoff", () => {
	it("puts the contract on the wire, with no NestJS framing around it", async () => {
		const fake = fakeConnection();
		const built = service(fake, {
			handler: async (received) => ({
				ok: true,
				parkLotId: received.parkLotId,
				slot: received.slot,
				instanceId: "engine-1",
				bridgeId: received.bridgeId,
				legId: "leg-c",
			}),
		});
		built.onApplicationBootstrap();

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toEqual([
			{
				ok: true,
				parkLotId: LOT_ID,
				slot: 401,
				instanceId: "engine-1",
				bridgeId: "bridge-1",
				legId: "leg-c",
			},
		]);
		expect(built.stats.served).toBe(1);
	});

	it("refuses a payload that is not the contract, rather than staying silent", async () => {
		const fake = fakeConnection();
		const built = service(fake, {
			handler: async () => {
				throw new Error("a malformed request must never reach the handler");
			},
		});
		built.onApplicationBootstrap();

		await fake.deliver('{"slot":"not a number"}');

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "bad_request" });
	});

	it("answers internal when the handler throws, because a silence costs the whole timeout", async () => {
		const fake = fakeConnection();
		const built = service(fake, {
			handler: async () => {
				throw new Error("the registry is on fire");
			},
		});
		built.onApplicationBootstrap();

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal", slot: 401 });
	});

	it("answers internal when no handler is registered yet", async () => {
		const fake = fakeConnection();
		const built = service(fake);
		built.onApplicationBootstrap();

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal" });
	});
});

describe("issuing a handoff", () => {
	it("addresses the owner's own subject and sends the bare contract", async () => {
		const fake = fakeConnection({
			reply: { ok: true, parkLotId: LOT_ID, slot: 401, instanceId: "engine-owner" },
		});
		const built = service(fake);

		const response = await built.handoff("engine-owner", request());

		expect(fake.sent[0]?.subject).toBe(subjectFor.engineParkHandoffRpc("engine-owner"));
		expect(fake.sent[0]?.payload).toEqual(request());
		expect(response).toMatchObject({ ok: true, instanceId: "engine-owner" });
	});

	it("throws rather than inventing a refusal when nothing answers", async () => {
		const fake = fakeConnection({ requestThrows: true });
		const built = service(fake);
		await expect(built.handoff("engine-owner", request())).rejects.toThrow(ParkHandoffError);
	});

	it("throws on a reply that does not match the contract — it may well have bridged the call", async () => {
		const fake = fakeConnection({ reply: { ok: "yes" } });
		const built = service(fake);
		await expect(built.handoff("engine-owner", request())).rejects.toThrow(ParkHandoffError);
	});
});
