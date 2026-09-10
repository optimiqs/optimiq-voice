import { describe, expect, it } from "bun:test";
import { EngineLivenessService } from "./engine-liveness.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type { EngineInstanceLease } from "@optimiq-voice/events";

const NOW = 1_785_000_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lease(overrides: Partial<EngineInstanceLease> & { instanceId: string }): Uint8Array {
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
 * An `engine-instances` bucket whose watch is driven by the test, and whose writes are recorded.
 *
 * Unlike the `sip-instances` fake, this service is both a READER and a WRITER of its bucket, so the
 * fake has to answer `put` and `delete` too — the lease this process claims for itself is half of
 * what the service is for.
 */
function fakeBucket(options: { failWrites?: boolean } = {}) {
	const queue: { key: string; operation: string; value: Uint8Array }[] = [];
	const puts: { key: string; lease: EngineInstanceLease }[] = [];
	const deletes: string[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	let failWrites = options.failWrites ?? false;

	async function* entries(): AsyncGenerator<{ key: string; operation: string; value: Uint8Array }> {
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
		puts,
		deletes,
		setFailWrites: (fail: boolean) => {
			failWrites = fail;
		},
		push: async (key: string, operation: string, value: Uint8Array) => {
			queue.push({ key, operation, value });
			for (let turn = 0; turn < 50 && queue.length > 0; turn += 1) {
				wake?.();
				wake = undefined;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		bucket: {
			put: async (key: string, value: Uint8Array) => {
				await Promise.resolve();
				if (failWrites) {
					throw new Error("broker unavailable");
				}
				puts.push({ key, lease: JSON.parse(decoder.decode(value)) as EngineInstanceLease });
				return puts.length;
			},
			delete: async (key: string) => {
				await Promise.resolve();
				deletes.push(key);
			},
			watch: async () => {
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

function harness(options: { failWrites?: boolean; instanceId?: string } = {}) {
	const fake = fakeBucket({ failWrites: options.failWrites });
	const jetstream = { engineInstances: fake.bucket } as unknown as JetStreamService;
	const env = { ENGINE_INSTANCE_ID: options.instanceId ?? "engine-a" } as EngineEnv;
	const service = new EngineLivenessService(jetstream, env);
	const contested: string[] = [];
	service.setInstanceLostHandler(async (instanceId) => {
		await Promise.resolve();
		contested.push(instanceId);
	});
	return { fake, service, contested };
}

describe("EngineLivenessService", () => {
	it("claims its own lease at start and reports holding it", async () => {
		const { fake, service } = harness();
		await service.start();

		expect(fake.puts).toHaveLength(1);
		expect(fake.puts[0]?.key).toBe("engine-a");
		expect(fake.puts[0]?.lease.instanceId).toBe("engine-a");
		expect(fake.puts[0]?.lease.expiresAt).toBeGreaterThan(fake.puts[0]?.lease.renewedAt ?? 0);
		expect(service.isLeaseHeld).toBe(true);
		await service.onApplicationShutdown();
	});

	/**
	 * The one failure that is fatal, and it is fatal at BOOT deliberately. An instance that cannot
	 * write its own key looks dead to every peer, so the moment it admits a call every survivor is
	 * entitled to contest that call's channel out from under it — a split brain produced by a missing
	 * grant or a missing bucket, which is a deployment fault and belongs where deployment faults are
	 * cheap to see.
	 */
	it("refuses to start when the first claim cannot be written", async () => {
		const { service } = harness({ failWrites: true });
		await expect(service.start()).rejects.toThrow(/liveness lease/);
		expect(service.isLeaseHeld).toBe(false);
	});

	it("contests a peer's channels exactly once when its lease is deleted", async () => {
		const { fake, service, contested } = harness();
		await service.start();
		await fake.push("engine-b", "PUT", lease({ instanceId: "engine-b" }));
		expect(service.liveInstances).toEqual(["engine-b"]);

		await fake.push("engine-b", "DEL", new Uint8Array());
		await fake.push("engine-b", "DEL", new Uint8Array());
		await service.awaitContests();

		expect(contested).toEqual(["engine-b"]);
		expect(service.lostCount).toBe(1);
		await service.onApplicationShutdown();
	});

	/**
	 * This process writes the bucket, so its own key comes back on its own watch — including the
	 * DELETE it publishes on a graceful shutdown. Acting on it would run the peer-death path against
	 * ourselves and contest every channel this instance is actively serving.
	 */
	it("never reports its own instance id, however the key changes", async () => {
		const { fake, service, contested } = harness({ instanceId: "engine-a" });
		await service.start();
		await fake.push("engine-a", "PUT", lease({ instanceId: "engine-a" }));
		await fake.push("engine-a", "DEL", new Uint8Array());
		await service.awaitContests();

		expect(contested).toEqual([]);
		expect(service.liveInstances).toEqual([]);
		await service.onApplicationShutdown();
	});

	/** The backstop the watch cannot be: a lease nobody deleted, that simply ran out. */
	it("contests a peer whose lease lapsed with no delete", async () => {
		const { fake, service, contested } = harness();
		await service.start();
		await fake.push("engine-b", "PUT", lease({ instanceId: "engine-b" }));

		service.sweep(NOW + 14_999);
		expect(contested).toEqual([]);
		service.sweep(NOW + 15_000);
		await service.awaitContests();

		expect(contested).toEqual(["engine-b"]);
		await service.onApplicationShutdown();
	});

	/**
	 * A value that names a different instance from its key cannot be attributed, and acting on it
	 * would contest a third party's channels off a write nobody authorised.
	 */
	it("ignores a lease whose value names a different instance", async () => {
		const { fake, service, contested } = harness();
		await service.start();
		await fake.push("engine-b", "PUT", lease({ instanceId: "engine-c" }));

		expect(service.liveInstances).toEqual([]);
		expect(contested).toEqual([]);
		await service.onApplicationShutdown();
	});

	/**
	 * The asymmetry with the first write. A refused RENEWAL is a broker hiccup with two more attempts
	 * inside the horizon; killing a process holding live calls over one refused write would cause the
	 * outage it is meant to avoid. It is counted and surfaced instead.
	 */
	it("keeps running when a renewal fails, and records it", async () => {
		const { fake, service } = harness();
		await service.start();
		fake.setFailWrites(true);
		await service["renew"]();

		expect(service.isLeaseHeld).toBe(false);
		expect(service.renewFailureCount).toBe(1);

		fake.setFailWrites(false);
		await service["renew"]();
		expect(service.isLeaseHeld).toBe(true);
		await service.onApplicationShutdown();
	});

	/**
	 * Released rather than left to lapse: a graceful shutdown has already drained its channels, and a
	 * key left behind makes every survivor wait out the full horizon before it can be sure — which a
	 * rolling deploy would pay once per replica for nothing.
	 */
	it("releases its lease on shutdown", async () => {
		const { fake, service } = harness();
		await service.start();
		await service.onApplicationShutdown();

		expect(fake.deletes).toEqual(["engine-a"]);
	});
});
