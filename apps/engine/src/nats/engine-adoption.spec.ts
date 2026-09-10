import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ENGINE_INSTANCES_KV, kvKeyFor } from "@optimiq-voice/events";
import { startBroker, type Broker } from "../../bench/broker";
import { withChannelOwnership } from "./channel-ownership";
import { EngineLivenessService, ENGINE_LEASE_TTL_MS } from "./engine-liveness.service";
import { JetStreamService } from "./jetstream.service";
import type { EngineEnv } from "../config/engine-env";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/**
 * Second-engine ownership adoption, against a REAL broker.
 *
 * The live finding this pins: an engine SIGKILLed mid-call left its channels in the `channels`
 * bucket with an UNEXPIRED ninety-second ownership lease, and the survivor adopted nothing — it sat
 * at `activeChannels: 0` for the whole observation window while the call stayed up, unbillable and
 * un-endable. The only recovery was to restart the survivor.
 *
 * A fake bucket cannot prove the fix, because the fix is two things a fake does not have: a real KV
 * TTL expiring the dead instance's lease key, and a real revision-fenced `update` deciding which of
 * two contesting survivors wins the channel. Both are exercised here.
 *
 * ```sh
 * NATS_SERVER_BIN=$(which nats-server) bun test apps/engine/src/nats/engine-adoption.spec.ts
 * ```
 */
const ENABLED = (process.env.NATS_SERVER_BIN ?? "") !== "";

const ORG = "0195c0f0-1c2f-7000-8000-0000000000f1";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const CHANNEL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";

function env(instanceId: string, url: string): EngineEnv {
	return {
		NATS_URL: url,
		ENGINE_INSTANCE_ID: instanceId,
		ENGINE_CLAIM_HEARTBEAT_MS: 29_999,
		// The definitions must be APPLIED, not left to `views.kv`'s defaults. Without this the bucket
		// is created with no `max_age`, and the server-side expiry half of the lease — the half that
		// publishes a death with nobody polling for it — silently does not exist.
		ENGINE_ENSURE_STREAMS: true,
	} as unknown as EngineEnv;
}

function snapshot(): ChannelSnapshot {
	return {
		organizationId: ORG,
		callId: CALL,
		channelId: CHANNEL,
		ariChannelId: CHANNEL,
		state: "up",
		variables: { OPTIMIQ_SIPD_INSTANCE_ID: "sipd-1" },
	} as unknown as ChannelSnapshot;
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("timed out waiting for a condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe.skipIf(!ENABLED)("second-engine adoption against a real broker", () => {
	let broker: Broker;
	const services: JetStreamService[] = [];
	const liveness: EngineLivenessService[] = [];

	beforeAll(async () => {
		broker = await startBroker();
	});

	afterAll(async () => {
		for (const service of liveness) {
			await service.onApplicationShutdown();
		}
		for (const service of services) {
			await service.onApplicationShutdown();
		}
		broker.stop();
	});

	async function engine(instanceId: string): Promise<{
		jetstream: JetStreamService;
		lease: EngineLivenessService;
		adopted: string[];
	}> {
		const jetstream = new JetStreamService(env(instanceId, broker.url));
		await jetstream.onModuleInit();
		services.push(jetstream);
		const lease = new EngineLivenessService(jetstream, env(instanceId, broker.url));
		liveness.push(lease);
		const adopted: string[] = [];
		lease.setInstanceLostHandler(async (dead) => {
			for await (const candidate of jetstream.channelSnapshots()) {
				if ((await jetstream.adoptChannelFromInstance(candidate, dead)) === "claimed") {
					adopted.push(candidate.channelId);
				}
			}
		});
		return { jetstream, lease, adopted };
	}

	/**
	 * The whole scenario in one: two engines, one dies holding a channel whose ownership lease is
	 * still good for another eighty-odd seconds, and the survivor takes it inside the fifteen-second
	 * INSTANCE lease instead. Reverting the contest to the expiry-fenced `adoptChannel` leaves
	 * `adopted` empty, which is the live behaviour this pins.
	 */
	it("adopts a dead engine's channel inside the instance lease, not the channel lease", async () => {
		const dead = await engine("engine-dead");
		const survivor = await engine("engine-live");
		await dead.lease.start();
		await survivor.lease.start();
		await waitFor(() => survivor.lease.liveInstances.includes("engine-dead"));

		// The dead engine takes a channel, with a full ninety-second ownership lease.
		expect(await dead.jetstream.claimChannel(snapshot())).toBe("claimed");
		const held = await dead.jetstream.readChannel(ORG, CALL, CHANNEL);
		expect(held?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe("engine-dead");
		expect(Number(held?.variables.OPTIMIQ_ENGINE_OWNER_EXPIRES_AT)).toBeGreaterThan(
			Date.now() + 60_000,
		);

		// SIGKILL, as the bucket sees it: the process stops renewing and never releases its key. The
		// server's own TTL is what publishes the death — no client-side timer is involved.
		clearInterval(
			(dead.lease as unknown as { renewTimer: ReturnType<typeof setInterval> }).renewTimer,
		);

		await waitFor(() => survivor.adopted.length > 0, ENGINE_LEASE_TTL_MS + 15_000);
		expect(survivor.adopted).toEqual([CHANNEL]);
		const now = await survivor.jetstream.readChannel(ORG, CALL, CHANNEL);
		expect(now?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe("engine-live");
	}, 90_000);

	/**
	 * Exactly one survivor wins. The fence is the revision-CAS, not the channel expiry: both engines
	 * read the same revision and both write at it, and the broker lets exactly one through.
	 */
	it("gives a contested channel to exactly one survivor", async () => {
		const a = await engine("engine-a");
		const b = await engine("engine-b");
		const seed = await engine("engine-gone");
		const key = kvKeyFor.channel(ORG, CALL, `${CHANNEL}-2`);
		expect(key).toContain(ORG);
		const contested = { ...snapshot(), channelId: `${CHANNEL}-2` } as ChannelSnapshot;
		expect(await seed.jetstream.claimChannel(contested)).toBe("claimed");

		const results = await Promise.all([
			a.jetstream.adoptChannelFromInstance(contested, "engine-gone"),
			b.jetstream.adoptChannelFromInstance(contested, "engine-gone"),
		]);

		expect(results.filter((result) => result === "claimed")).toHaveLength(1);
		expect(results.filter((result) => result === "owned")).toHaveLength(1);
	}, 60_000);

	/** The bucket the whole feature rests on is applied by the shipped definition, not by hand. */
	it("applies the engine-instances bucket from its shipped definition", async () => {
		const one = await engine("engine-def");
		const bucket = one.jetstream.engineInstances;
		expect(bucket).toBeDefined();
		await one.lease.start();
		const entry = await bucket?.get(kvKeyFor.engineInstance("engine-def"));
		expect(entry).not.toBeNull();
		const status = await bucket?.status();
		expect(status?.bucket).toBe(ENGINE_INSTANCES_KV.name);
		expect(status?.ttl).toBe(ENGINE_INSTANCES_KV.ttlMs);
		// The one that actually enforces the lease. A bucket opened without its definition — which is
		// what `views.kv(name)` alone does — comes back with `max_age: 0`, and then a dead instance's
		// key never expires server-side and only the client sweep is left. Nanoseconds, on the wire.
		expect(
			(status as unknown as { streamInfo: { config: { max_age: number } } }).streamInfo.config
				.max_age,
		).toBe(ENGINE_INSTANCES_KV.ttlMs * 1_000_000);
	}, 60_000);

	/** A snapshot the withChannelOwnership helper wrote is readable by the contest, byte for byte. */
	it("round-trips an ownership stamp through the real bucket", async () => {
		const one = await engine("engine-rt");
		const stamped = withChannelOwnership(
			{ ...snapshot(), channelId: `${CHANNEL}-3` } as ChannelSnapshot,
			"engine-rt",
			Date.now() + 90_000,
		);
		expect(await one.jetstream.claimChannel(stamped)).toBe("claimed");
		const read = await one.jetstream.readChannel(ORG, CALL, `${CHANNEL}-3`);
		expect(read?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe("engine-rt");
	}, 60_000);
});
