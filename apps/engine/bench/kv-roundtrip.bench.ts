/**
 * Bench 2 — the engine's per-call KV patterns through the REAL `JetStreamService`.
 *
 * ```sh
 * NATS_SERVER_BIN=/path/to/nats-server bun apps/engine/bench/kv-roundtrip.bench.ts
 * ```
 *
 * Every number here is a round trip to a real broker on loopback, so the interesting figure is
 * not the microsecond cost of a `put` but HOW MANY of them a pass makes — which is what
 * `channelSnapshots` (the ownership-maintenance recovery scan) is measured for.
 */
import { loadEngineEnv } from "../src/config/engine-env";
import { JetStreamService } from "../src/nats/jetstream.service";
import { percentiles, startBroker } from "./broker";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

const CHANNELS = Number(process.env.BENCH_CHANNELS ?? 300);

function snapshotFor(orgId: string, index: number): ChannelSnapshot {
	const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
	return {
		organizationId: orgId,
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

async function timed(
	label: string,
	count: number,
	run: (index: number) => Promise<unknown>,
): Promise<void> {
	const samples: number[] = [];
	const startedAt = performance.now();
	for (let index = 0; index < count; index += 1) {
		const at = performance.now();
		await run(index);
		samples.push(performance.now() - at);
	}
	const elapsed = performance.now() - startedAt;
	const { p50, p99 } = percentiles(samples);
	console.log(
		`${label.padEnd(34)} n=${String(count).padEnd(5)} total ${elapsed.toFixed(0)}ms  ` +
			`mean ${(elapsed / count).toFixed(3)}ms  p50 ${p50.toFixed(3)}ms  p99 ${p99.toFixed(3)}ms`,
	);
}

async function main(): Promise<void> {
	const broker = await startBroker();
	try {
		const env = loadEngineEnv({
			NATS_URL: broker.url,
			ENGINE_ENSURE_STREAMS: "true",
			ENGINE_INSTANCE_ID: "bench-engine",
			ARI_PASSWORD: "bench",
		} as Readonly<Record<string, string>>);
		const service = new JetStreamService(env);
		await service.onModuleInit();

		const orgId = "00000000-0000-4000-8000-0000000000aa";
		const snapshots = Array.from({ length: CHANNELS }, (_, index) => snapshotFor(orgId, index));

		await timed("claimChannel (KV create)", CHANNELS, async (index) => {
			await service.claimChannel(snapshots[index]!);
		});
		await timed("renewChannel (CAS update)", CHANNELS, async (index) => {
			await service.renewChannel(snapshots[index]!);
		});
		await timed("readChannel (point get)", CHANNELS, async (index) => {
			const snapshot = snapshots[index]!;
			await service.readChannel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		});

		for (const pass of [1, 2]) {
			const at = performance.now();
			let seen = 0;
			for await (const snapshot of service.channelSnapshots()) {
				seen += snapshot.channelId.length > 0 ? 1 : 0;
			}
			console.log(
				`channelSnapshots pass ${String(pass)}: ${String(seen)} snapshots in ` +
					`${(performance.now() - at).toFixed(0)}ms`,
			);
		}

		await timed("deleteChannel", CHANNELS, async (index) => {
			await service.deleteChannel(snapshots[index]!);
		});

		await service.onApplicationShutdown();
	} finally {
		broker.stop();
	}
}

await main();
