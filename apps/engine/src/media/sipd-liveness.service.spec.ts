import { describe, expect, it } from "bun:test";
import { SipdLivenessService } from "./sipd-liveness.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { SipInstanceLease } from "@optimiq-voice/events";

const NOW = 1_785_000_000_000;
const encoder = new TextEncoder();

function lease(overrides: Partial<SipInstanceLease> & { instanceId: string }): Uint8Array {
	return encoder.encode(
		JSON.stringify({
			startedAt: NOW - 60_000,
			renewedAt: NOW,
			expiresAt: NOW + 15_000,
			...overrides,
		}),
	);
}

/**
 * A `sip-instances` bucket whose watch is driven by the test.
 *
 * The whole point of the service is what it does with entries the broker publishes, so the fake is
 * the watch and nothing else: `push` delivers one entry, `end` ends the iteration the way a broker
 * restart would.
 */
function fakeBucket() {
	const queue: { key: string; operation: string; value: Uint8Array }[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	let watches = 0;

	async function* entries(): AsyncGenerator<{
		key: string;
		operation: string;
		value: Uint8Array;
	}> {
		while (!ended) {
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	}

	return {
		watchCount: () => watches,
		push: async (key: string, operation: string, value: Uint8Array) => {
			queue.push({ key, operation, value });
			// The watch is established asynchronously, so the first push can arrive before anything
			// is iterating. Waking and yielding until the queue drains is what makes the fake
			// deterministic without a sleep.
			for (let turn = 0; turn < 50 && queue.length > 0; turn += 1) {
				wake?.();
				wake = undefined;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		end: () => {
			ended = true;
			wake?.();
		},
		bucket: {
			watch: async () => {
				watches += 1;
				await Promise.resolve();
				const iterator = entries();
				return {
					[Symbol.asyncIterator]: () => iterator,
					stop: () => {
						ended = true;
						wake?.();
					},
				};
			},
		},
	};
}

function harness() {
	const fake = fakeBucket();
	const jetstream = { sipInstances: fake.bucket } as unknown as JetStreamService;
	const service = new SipdLivenessService(jetstream);
	const lost: string[] = [];
	service.setInstanceLostHandler((instanceId) => {
		lost.push(instanceId);
	});
	return { fake, service, lost };
}

describe("SipdLivenessService", () => {
	it("learns a live edge from its lease and reports it in liveInstances", async () => {
		const { fake, service, lost } = harness();
		service.start();
		await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-7c9f" }));

		expect(service.liveInstances).toEqual(["sipd-7c9f"]);
		expect(lost).toEqual([]);
		await service.onApplicationShutdown();
	});

	/**
	 * The fast path, and the one that fires in production: the bucket TTL is the lease, so the server
	 * publishes a delete for an instance that stopped renewing. A PURGE and a DEL mean the same
	 * thing to a caller — that edge is gone — and both have to end its calls.
	 */
	it("reports a loss on a delete or a purge, once", async () => {
		for (const operation of ["DEL", "PURGE"]) {
			const { fake, service, lost } = harness();
			service.start();
			await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-7c9f" }));
			await fake.push("sipd-7c9f", operation, new Uint8Array());
			await fake.push("sipd-7c9f", operation, new Uint8Array());

			expect(lost).toEqual(["sipd-7c9f"]);
			expect(service.liveInstances).toEqual([]);
			expect(service.lostCount).toBe(1);
			await service.onApplicationShutdown();
		}
	});

	/**
	 * The backstop. A watch that silently ended, or a purge notification the client never delivered,
	 * would otherwise leave a dead instance looking alive forever — which is the exact failure this
	 * service exists to be the thing that notices.
	 */
	it("reports a loss from the expiry sweep when no delete ever arrives", async () => {
		const { fake, service, lost } = harness();
		service.start();
		await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-7c9f" }));

		service.sweep(NOW + 14_999);
		expect(lost).toEqual([]);
		service.sweep(NOW + 15_000);
		expect(lost).toEqual(["sipd-7c9f"]);
		// Forgotten on report, so a later sweep cannot refile the CDRs the handler just wrote.
		service.sweep(NOW + 60_000);
		expect(lost).toEqual(["sipd-7c9f"]);
		await service.onApplicationShutdown();
	});

	it("re-learns an edge that comes back and can lose it again", async () => {
		const { fake, service, lost } = harness();
		service.start();
		await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-7c9f" }));
		await fake.push("sipd-7c9f", "DEL", new Uint8Array());
		await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-7c9f" }));
		await fake.push("sipd-7c9f", "DEL", new Uint8Array());

		expect(lost).toEqual(["sipd-7c9f", "sipd-7c9f"]);
		await service.onApplicationShutdown();
	});

	/**
	 * The key IS the instance id by contract. Acting on a value that disagrees would end another
	 * instance's calls, which is the one mistake this service must never make.
	 */
	it("ignores an unreadable lease and one whose value names a different instance", async () => {
		const { fake, service, lost } = harness();
		service.start();
		await fake.push("sipd-7c9f", "PUT", encoder.encode("{not json"));
		await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-other" }));

		expect(service.liveInstances).toEqual([]);
		expect(lost).toEqual([]);
		await service.onApplicationShutdown();
	});

	/**
	 * A handler that throws must not end the watch. It is the only thing on the platform watching
	 * the signalling plane's liveness, and losing it silently is the failure mode in miniature.
	 */
	it("survives a handler that throws and keeps watching", async () => {
		const { fake, service } = harness();
		service.setInstanceLostHandler(() => {
			throw new Error("the orchestrator exploded");
		});
		service.start();
		await fake.push("sipd-7c9f", "PUT", lease({ instanceId: "sipd-7c9f" }));
		await fake.push("sipd-7c9f", "DEL", new Uint8Array());
		await fake.push("sipd-2b41", "PUT", lease({ instanceId: "sipd-2b41" }));

		expect(service.liveInstances).toEqual(["sipd-2b41"]);
		expect(service.isWatching).toBe(true);
		await service.onApplicationShutdown();
	});

	it("refuses to start without a handler, since a loss nobody acts on is worse than none", () => {
		const service = new SipdLivenessService({} as unknown as JetStreamService);
		expect(() => {
			service.start();
		}).toThrow(/instance-lost handler/);
	});
});
