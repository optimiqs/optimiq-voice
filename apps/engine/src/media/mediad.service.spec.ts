import { describe, expect, it } from "bun:test";
import { loadEngineEnv } from "../config/engine-env";
import { MediadService } from "./mediad.service";
import type { JetStreamService } from "../nats/jetstream.service";

function fakeConnection() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const subscriptions: { readonly subject: string; readonly queue?: string }[] = [];
	let closed = false;
	let wake: (() => void) | undefined;
	let responding = true;
	let requests = 0;
	let requestBlock: Promise<void> | undefined;
	let releaseRequestBlock: (() => void) | undefined;
	let flushes = 0;
	let flushBlock: Promise<void> | undefined;
	let releaseFlushBlock: (() => void) | undefined;

	// oxlint-disable-next-line require-yield -- an AsyncGenerator<never> that blocks until closed
	async function* messages(): AsyncGenerator<never> {
		while (!closed) {
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	}

	const iterator = messages();
	const subscription = {
		[Symbol.asyncIterator]: () => iterator,
		unsubscribe: () => {
			closed = true;
			wake?.();
		},
		drain: async () => {
			closed = true;
			wake?.();
			await Promise.resolve();
		},
	};
	const connection = {
		request: async (_subject: string, payload: Uint8Array) => {
			requests += 1;
			await requestBlock;
			if (!responding) {
				throw new Error("no responders");
			}
			const request = JSON.parse(decoder.decode(payload)) as { sessionId: string };
			return {
				data: encoder.encode(
					JSON.stringify({
						ok: true,
						sessionId: request.sessionId,
						released: false,
						instanceId: "mediad-1",
					}),
				),
			};
		},
		flush: async () => {
			flushes += 1;
			await flushBlock;
		},
		subscribe: (subject: string, options?: { queue?: string }) => {
			subscriptions.push({
				subject,
				...(options?.queue === undefined ? {} : { queue: options.queue }),
			});
			return subscription;
		},
		isClosed: () => false,
	};

	return {
		connection,
		subscriptions,
		setResponding: (value: boolean) => {
			responding = value;
		},
		blockRequests: () => {
			requestBlock = new Promise<void>((resolve) => {
				releaseRequestBlock = resolve;
			});
			return () => {
				releaseRequestBlock?.();
				requestBlock = undefined;
				releaseRequestBlock = undefined;
			};
		},
		requestCount: () => requests,
		blockFlush: () => {
			flushBlock = new Promise<void>((resolve) => {
				releaseFlushBlock = resolve;
			});
			return () => {
				releaseFlushBlock?.();
				flushBlock = undefined;
				releaseFlushBlock = undefined;
			};
		},
		flushCount: () => flushes,
	};
}

describe("MediadService readiness", () => {
	it("becomes ready only after the responder probe and unqueued event subscription", async () => {
		const fake = fakeConnection();
		const jetstream = {
			rawConnection: fake.connection,
			serverUrl: "nats://127.0.0.1:4222",
		} as unknown as JetStreamService;
		const service = new MediadService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), jetstream);

		expect(service.isReady).toBe(false);
		expect(service.subscriptionState).toBe("idle");

		await service.onModuleInit();
		expect(service.isReachable).toBe(true);
		expect(service.isReady).toBe(false);
		const internals = service as unknown as {
			probeTimer?: ReturnType<typeof setInterval>;
		};
		expect(internals.probeTimer).toBeDefined();

		service.setEventHandler(() => undefined);
		await service.start();

		expect(service.isReady).toBe(true);
		expect(service.subscriptionState).toBe("subscribed");
		// No queue group: every event must reach the replica that owns its local channel registry.
		expect(fake.subscriptions).toEqual([{ subject: "media.evt.v1.>" }]);

		await service.onApplicationShutdown();
		expect(service.isReady).toBe(false);
		expect(service.subscriptionState).toBe("closed");
		expect(internals.probeTimer).toBeUndefined();
	});

	it("degrades readiness when responders disappear and recovers when they return", async () => {
		const fake = fakeConnection();
		const service = new MediadService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), {
			rawConnection: fake.connection,
			serverUrl: "nats://127.0.0.1:4222",
		} as unknown as JetStreamService);
		await service.onModuleInit();
		service.setEventHandler(() => undefined);
		await service.start();
		expect(service.isReady).toBe(true);

		fake.setResponding(false);
		await expect(service.probeReachability()).resolves.toBe(false);
		expect(service.isReachable).toBe(false);
		expect(service.isReady).toBe(false);

		fake.setResponding(true);
		await expect(service.probeReachability()).resolves.toBe(true);
		expect(service.isReady).toBe(true);
		await service.onApplicationShutdown();
	});

	it("does not mark the event subscription ready until NATS flush acknowledges it", async () => {
		const fake = fakeConnection();
		const service = new MediadService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), {
			rawConnection: fake.connection,
			serverUrl: "nats://127.0.0.1:4222",
		} as unknown as JetStreamService);
		await service.onModuleInit();
		service.setEventHandler(() => undefined);
		const releaseFlush = fake.blockFlush();

		const starting = service.start();
		await Promise.resolve();
		await Promise.resolve();
		expect(fake.flushCount()).toBe(1);
		expect(service.subscriptionState).toBe("idle");
		expect(service.isReady).toBe(false);

		releaseFlush();
		await starting;
		expect(service.subscriptionState).toBe("subscribed");
		expect(service.isReady).toBe(true);
		await service.onApplicationShutdown();
	});

	it("coalesces overlapping reachability probes", async () => {
		const fake = fakeConnection();
		const service = new MediadService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), {
			rawConnection: fake.connection,
			serverUrl: "nats://127.0.0.1:4222",
		} as unknown as JetStreamService);
		await service.onModuleInit();
		const release = fake.blockRequests();

		const first = service.probeReachability();
		const second = service.probeReachability();
		await Promise.resolve();
		await Promise.resolve();
		expect(fake.requestCount()).toBe(2);
		release();
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		expect(fake.requestCount()).toBe(2);
		await service.onApplicationShutdown();
	});

	it("still fails boot when no responder answers the initial probe", async () => {
		const fake = fakeConnection();
		fake.setResponding(false);
		const service = new MediadService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), {
			rawConnection: fake.connection,
			serverUrl: "nats://127.0.0.1:4222",
		} as unknown as JetStreamService);

		await expect(service.onModuleInit()).rejects.toThrow("no mediad answered");
		expect(service.isReachable).toBe(false);
	});
});
