import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startBroker, type Broker } from "../../bench/broker";
import { loadEngineEnv } from "../config/engine-env";
import { JetStreamService } from "./jetstream.service";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/**
 * `channelSnapshots` against a REAL JetStream KV bucket.
 *
 * Gated on `NATS_SERVER_BIN` because it needs a broker; there is no way to prove the thing this
 * regression is about — that `kv.keys()` is an ordered consumer which terminates when a `kv.get`
 * is awaited inside its iteration — against a fake bucket, since the fake has no consumer.
 *
 * ```sh
 * NATS_SERVER_BIN=$(which nats-server) bun test apps/engine/src/nats/jetstream-channel-scan.spec.ts
 * ```
 */
const ENABLED = (process.env.NATS_SERVER_BIN ?? "") !== "";
const CHANNELS = 300;
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";

function snapshotFor(index: number): ChannelSnapshot {
	const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
	return {
		organizationId: ORG_ID,
		callId: id,
		channelId: id,
		ariChannelId: `ari-${String(index)}`,
		state: "up",
		direction: "inbound",
		leg: "a",
		from: { number: "+15550001111" },
		to: { number: "+15550002222" },
		createdAt: new Date().toISOString(),
		variables: {},
	} as unknown as ChannelSnapshot;
}

describe.skipIf(!ENABLED)("JetStreamService.channelSnapshots", () => {
	let broker: Broker;
	let service: JetStreamService;

	beforeAll(async () => {
		broker = await startBroker();
		service = new JetStreamService(
			loadEngineEnv({
				NATS_URL: broker.url,
				ENGINE_ENSURE_STREAMS: "true",
				ENGINE_INSTANCE_ID: "scan-spec",
				ARI_PASSWORD: "scan-spec",
			} as Readonly<Record<string, string>>),
		);
		await service.onModuleInit();
		for (let index = 0; index < CHANNELS; index += 1) {
			expect(await service.claimChannel(snapshotFor(index))).toBe("claimed");
		}
	});

	afterAll(async () => {
		await service.onApplicationShutdown();
		broker.stop();
	});

	it("yields every live channel, not the first one the key listing happened to deliver", async () => {
		const seen: string[] = [];
		for await (const snapshot of service.channelSnapshots()) {
			seen.push(snapshot.channelId);
		}
		expect(seen).toHaveLength(CHANNELS);
		expect(new Set(seen).size).toBe(CHANNELS);
		expect(seen).toContain(snapshotFor(CHANNELS - 1).channelId);
	});
});
