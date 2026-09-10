import { describe, expect, it } from "bun:test";
import { withChannelOwnership } from "./channel-ownership";
import { ChannelWatchService } from "./channel-watch.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

const ORG = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const encoder = new TextEncoder();

function snapshot(channelId: string): ChannelSnapshot {
	return {
		organizationId: ORG,
		callId: CALL,
		channelId,
		state: "up",
		variables: {},
	} as unknown as ChannelSnapshot;
}

function owned(channelId: string, instanceId: string, expiresAt: number): Uint8Array {
	return encoder.encode(
		JSON.stringify(withChannelOwnership(snapshot(channelId), instanceId, expiresAt)),
	);
}

function fakeBucket(lastSeq = 0) {
	const queue: { key: string; operation: string; value: Uint8Array; revision: number }[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	let watches = 0;
	let seq = lastSeq;

	async function* entries(): AsyncGenerator<{
		key: string;
		operation: string;
		value: Uint8Array;
		revision: number;
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
		setLastSeq: (value: number) => {
			seq = value;
		},
		push: async (key: string, operation: string, value: Uint8Array, revision: number) => {
			queue.push({ key, operation, value, revision });
			for (let turn = 0; turn < 50 && queue.length > 0; turn += 1) {
				wake?.();
				wake = undefined;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		bucket: {
			status: async () => {
				await Promise.resolve();
				return { streamInfo: { state: { last_seq: seq } } };
			},
			watch: async () => {
				watches += 1;
				await Promise.resolve();
				ended = false;
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

function harness(options: { instanceId?: string; probeMs?: number } = {}) {
	const fake = fakeBucket();
	const jetstream = { channels: fake.bucket } as unknown as JetStreamService;
	const env = {
		ENGINE_INSTANCE_ID: options.instanceId ?? "engine-a",
		ENGINE_ROUTING_WATCH_PROBE_MS: options.probeMs ?? 3_600_000,
	} as EngineEnv;
	const service = new ChannelWatchService(jetstream, env);
	const contested: string[] = [];
	service.setSink({
		adoptOrphanedChannel: async (candidate) => {
			await Promise.resolve();
			contested.push(candidate.channelId);
			return true;
		},
	});
	return { fake, service, contested };
}

describe("ChannelWatchService", () => {
	/**
	 * The live signal that replaces "restart the survivor". Before this, a snapshot whose owner had
	 * stopped renewing was found only at boot or by the heartbeat's cluster-wide listing.
	 */
	it("contests a snapshot whose ownership lease has lapsed", async () => {
		const { fake, service, contested } = harness();
		service.start();
		await fake.push("k1", "PUT", owned("ch-1", "engine-dead", Date.now() - 1), 1);
		await service.awaitWork();

		expect(contested).toEqual(["ch-1"]);
		expect(service.adoptedCount).toBe(1);
		await service.onApplicationShutdown();
	});

	it("leaves a live replica's snapshot alone", async () => {
		const { fake, service, contested } = harness();
		service.start();
		await fake.push("k1", "PUT", owned("ch-1", "engine-b", Date.now() + 60_000), 1);
		await service.awaitWork();

		expect(contested).toEqual([]);
		await service.onApplicationShutdown();
	});

	/** Every renewal of every channel this instance holds comes back on its own watch. */
	it("ignores its own writes", async () => {
		const { fake, service, contested } = harness({ instanceId: "engine-a" });
		service.start();
		await fake.push("k1", "PUT", owned("ch-1", "engine-a", Date.now() - 1), 1);
		await service.awaitWork();

		expect(contested).toEqual([]);
		await service.onApplicationShutdown();
	});

	/** A delete is a leg that ENDED. Its owner cleared it, and there is nothing to adopt. */
	it("does not contest a deleted key", async () => {
		const { fake, service, contested } = harness();
		service.start();
		await fake.push("k1", "DEL", new Uint8Array(), 1);
		await service.awaitWork();

		expect(contested).toEqual([]);
		await service.onApplicationShutdown();
	});

	/**
	 * The stale guard. A `kv.watch()` whose flow-control reply the broker refuses stops delivering
	 * SILENTLY — no error, no closed subscription, no end of iterator — so the only evidence left is
	 * that the bucket has moved past the newest revision the watch delivered.
	 */
	it("re-establishes a watch that is alive but behind the bucket", async () => {
		const { fake, service } = harness();
		service.start();
		await fake.push("k1", "PUT", owned("ch-1", "engine-a", Date.now() + 60_000), 5);
		expect(fake.watchCount()).toBe(1);

		fake.setLastSeq(40);
		// One probe is not enough: a write genuinely in flight is not a stall.
		await service.probe();
		expect(service.staleRecoveryCount).toBe(0);
		expect(fake.watchCount()).toBe(1);

		await service.probe();
		expect(service.staleRecoveryCount).toBe(1);
		// The stop ends the iteration; the loop's backoff then re-establishes it.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(fake.watchCount()).toBe(2);
		await service.onApplicationShutdown();
	});

	/**
	 * A revision no watch can reach — a superseded write the bucket has already compacted away —
	 * must cost exactly one recovery, not a re-created watch every probe for ever.
	 */
	it("recovers once for a revision the watch can never reach", async () => {
		const { fake, service } = harness();
		service.start();
		await fake.push("k1", "PUT", owned("ch-1", "engine-a", Date.now() + 60_000), 5);
		fake.setLastSeq(40);

		await service.probe();
		await service.probe();
		expect(service.staleRecoveryCount).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 800));

		await service.probe();
		await service.probe();
		expect(service.staleRecoveryCount).toBe(1);
		await service.onApplicationShutdown();
	});

	/** A quiet cluster is not a stalled watch, however long it stays quiet. */
	it("leaves a watch that is level with the bucket alone", async () => {
		const { fake, service } = harness();
		service.start();
		await fake.push("k1", "PUT", owned("ch-1", "engine-a", Date.now() + 60_000), 5);
		fake.setLastSeq(5);

		await service.probe();
		await service.probe();
		await service.probe();

		expect(service.staleRecoveryCount).toBe(0);
		expect(fake.watchCount()).toBe(1);
		await service.onApplicationShutdown();
	});
});
