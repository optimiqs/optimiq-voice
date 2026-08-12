import { describe, expect, it } from "bun:test";
import {
	CHANNEL_OWNER_EXPIRES_AT_VARIABLE,
	CHANNEL_OWNER_INSTANCE_VARIABLE,
	CHANNEL_OWNERSHIP_LEASE_MS,
} from "./channel-ownership";
import { JetStreamService } from "./jetstream.service";
import type { EngineEnv } from "../config/engine-env";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const CALL = "0195c0f0-1c2f-7000-8000-000000000002";
const LEG = "0195c0f0-1c2f-7000-8000-000000000003";
const KEY = `${ORG}.${CALL}.${LEG}`;

function snapshot(variables: Readonly<Record<string, string>> = {}): ChannelSnapshot {
	return {
		channelId: LEG,
		callId: CALL,
		organizationId: ORG,
		direction: "inbound",
		state: "created",
		callState: "down",
		flags: [],
		profile: { destinationNumber: "+15559876543", context: "from-trunk" },
		variables: { ...variables },
		createdAt: 1_754_899_200_000,
	};
}

function conflict(): Error {
	return Object.assign(new Error("wrong last sequence"), {
		api_error: { err_code: 10071 },
	});
}

class FakeChannelsKv {
	private readonly values = new Map<string, { value: Uint8Array; revision: number }>();
	private revision = 0;
	readonly updates: number[] = [];

	async create(key: string, value: Uint8Array): Promise<number> {
		if (this.values.has(key)) {
			throw conflict();
		}
		const revision = ++this.revision;
		this.values.set(key, { value, revision });
		return revision;
	}

	async get(key: string) {
		return this.values.get(key) ?? null;
	}

	async update(key: string, value: Uint8Array, previousSeq: number): Promise<number> {
		this.updates.push(previousSeq);
		if (this.values.get(key)?.revision !== previousSeq) {
			throw conflict();
		}
		const revision = ++this.revision;
		this.values.set(key, { value, revision });
		return revision;
	}

	async delete(key: string, options?: { previousSeq?: number }): Promise<void> {
		if (
			options?.previousSeq !== undefined &&
			this.values.get(key)?.revision !== options.previousSeq
		) {
			throw conflict();
		}
		this.values.delete(key);
	}

	read(key: string): ChannelSnapshot | undefined {
		const entry = this.values.get(key);
		return entry === undefined
			? undefined
			: (JSON.parse(new TextDecoder().decode(entry.value)) as ChannelSnapshot);
	}
}

function serviceWith(
	kv: object,
	instanceId = "engine-1",
	mediaDriver: EngineEnv["ENGINE_MEDIA_DRIVER"] = "ari",
): JetStreamService {
	const service = new JetStreamService({
		NATS_URL: "nats://127.0.0.1:4222",
		ENGINE_MEDIA_DRIVER: mediaDriver,
		ENGINE_INSTANCE_ID: instanceId,
	} as EngineEnv);
	Object.assign(service, { channelsKv: kv });
	return service;
}

describe("JetStreamService channel ownership", () => {
	it("claims the canonical key with a renewable ownership lease", async () => {
		const kv = new FakeChannelsKv();
		const service = serviceWith(kv);

		await expect(service.claimChannel(snapshot(), 1_000)).resolves.toBe("claimed");
		expect(kv.read(KEY)?.variables).toMatchObject({
			[CHANNEL_OWNER_INSTANCE_VARIABLE]: "engine-1",
			[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]: String(1_000 + CHANNEL_OWNERSHIP_LEASE_MS),
		});
	});

	it("admits an ARI channel on only one replica", async () => {
		const kv = new FakeChannelsKv();
		const first = serviceWith(kv, "engine-a");
		const second = serviceWith(kv, "engine-b");
		await first.claimChannel(snapshot(), 1_000);

		await expect(second.claimChannel(snapshot(), 2_000)).resolves.toBe("owned");
		expect(kv.read(KEY)?.variables[CHANNEL_OWNER_INSTANCE_VARIABLE]).toBe("engine-a");
	});

	it("does not admit a duplicate arrival already claimed by this replica", async () => {
		const kv = new FakeChannelsKv();
		const service = serviceWith(kv);
		await service.claimChannel(snapshot(), 1_000);

		await expect(service.claimChannel(snapshot(), 2_000)).resolves.toBe("owned");
	});

	it("re-adopts an unexpired same-instance lease during restart recovery", async () => {
		const kv = new FakeChannelsKv();
		const service = serviceWith(kv);
		await service.claimChannel(snapshot(), 1_000);

		await expect(service.adoptChannel(snapshot(), 2_000)).resolves.toBe("claimed");
		expect(kv.read(KEY)?.variables[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]).toBe(
			String(2_000 + CHANNEL_OWNERSHIP_LEASE_MS),
		);
	});

	it("adopts a legacy snapshot that has no ownership lease", async () => {
		const kv = new FakeChannelsKv();
		await kv.create(KEY, new TextEncoder().encode(JSON.stringify(snapshot())));
		const service = serviceWith(kv);

		await expect(service.adoptChannel(snapshot(), 1_000)).resolves.toBe("claimed");
		expect(kv.read(KEY)?.variables[CHANNEL_OWNER_INSTANCE_VARIABLE]).toBe("engine-1");
	});

	it("adopts a foreign lease once it expires", async () => {
		const kv = new FakeChannelsKv();
		const first = serviceWith(kv, "engine-a");
		const second = serviceWith(kv, "engine-b");
		await first.claimChannel(snapshot(), 1_000);

		await expect(second.claimChannel(snapshot(), 1_000 + CHANNEL_OWNERSHIP_LEASE_MS)).resolves.toBe(
			"claimed",
		);
		expect(kv.read(KEY)?.variables[CHANNEL_OWNER_INSTANCE_VARIABLE]).toBe("engine-b");
	});

	it("serializes local mirrors so each update quotes the preceding revision", async () => {
		const kv = new FakeChannelsKv();
		const service = serviceWith(kv);
		await service.claimChannel(snapshot(), 1_000);

		await Promise.all([
			service.persistChannel(snapshot({ OPTIMIQ_STEP: "one" }), 2_000),
			service.persistChannel(snapshot({ OPTIMIQ_STEP: "two" }), 3_000),
		]);

		expect(kv.updates).toEqual([1, 2]);
		expect(kv.read(KEY)?.variables.OPTIMIQ_STEP).toBe("two");
	});

	it("renews an owned lease with a revision-fenced snapshot write", async () => {
		const kv = new FakeChannelsKv();
		const service = serviceWith(kv);
		await service.claimChannel(snapshot(), 1_000);

		await expect(service.renewChannel(snapshot(), 4_000)).resolves.toBe("renewed");
		expect(kv.read(KEY)?.variables[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]).toBe(
			String(4_000 + CHANNEL_OWNERSHIP_LEASE_MS),
		);
		expect(service.ownedChannelLeaseExpiresAt(snapshot())).toBe(4_000 + CHANNEL_OWNERSHIP_LEASE_MS);
	});

	it("reports whether a strict channel persistence barrier was acknowledged", async () => {
		const kv = new FakeChannelsKv();
		const service = serviceWith(kv);
		await service.claimChannel(snapshot(), 1_000);

		await expect(service.persistChannel(snapshot(), 2_000)).resolves.toBe(true);
		await expect(
			new JetStreamService({
				NATS_URL: "nats://127.0.0.1:4222",
				ENGINE_MEDIA_DRIVER: "ari",
			} as EngineEnv).persistChannel(snapshot()),
		).resolves.toBe(false);
	});

	it("fences stale writes and deletes after another replica takes over", async () => {
		const kv = new FakeChannelsKv();
		const stale = serviceWith(kv, "engine-a");
		const owner = serviceWith(kv, "engine-b");
		await stale.claimChannel(snapshot(), 1_000);
		await owner.claimChannel(snapshot(), 1_000 + CHANNEL_OWNERSHIP_LEASE_MS);

		await expect(stale.persistChannel(snapshot({ OPTIMIQ_STALE: "true" }), 100_000)).resolves.toBe(
			false,
		);
		await stale.deleteChannel(snapshot());

		expect(kv.read(KEY)?.variables[CHANNEL_OWNER_INSTANCE_VARIABLE]).toBe("engine-b");
		expect(kv.read(KEY)?.variables.OPTIMIQ_STALE).toBeUndefined();
	});

	it("fails admission closed when the bucket is unavailable", async () => {
		const service = serviceWith({
			create: async () => {
				throw new Error("broker unavailable");
			},
		});

		await expect(service.claimChannel(snapshot())).resolves.toBe("unavailable");
	});
});
