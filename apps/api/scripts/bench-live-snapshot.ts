/**
 * A load harness for `LiveHub.snapshot` — the read that runs on every `subscribe`.
 *
 * A wallboard's first paint is one snapshot per topic, and a snapshot is a range read over a KV
 * bucket. How that read is issued decides whether opening the page costs one broker round trip or
 * one per registration, which on a tenant with a few hundred extensions is the difference between
 * "instant" and "a second and a half".
 *
 * Real NATS, not a fake: a benchmark of a round-trip count that does not make round trips would be
 * measuring nothing. Point it at a JetStream-enabled server:
 *
 *   nats-server -js -sd /tmp/js -p 4222 &
 *   NATS_URL=nats://127.0.0.1:4222 KEYS=300 \
 *     pnpm --filter @optimiq-voice/api exec tsx scripts/bench-live-snapshot.ts
 *
 * Environment: `NATS_URL` (required), `KEYS` (rows to seed, default 300), `ROUNDS` (snapshots to
 * time, default 20).
 */
import { connect, type NatsConnection } from "nats";
import { REGISTRATIONS_KV } from "@optimiq-voice/events/streams";
import { LiveHub } from "../src/live/live-hub.service";
import type { PbxEnv } from "../src/pbx/shared/pbx-env";

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";
const KEYS = Number(process.env.KEYS ?? 300);
const ROUNDS = Number(process.env.ROUNDS ?? 20);

async function main(): Promise<void> {
	const url = process.env.NATS_URL;
	if (url === undefined) {
		throw new Error("NATS_URL must point at a JetStream-enabled nats-server.");
	}

	const env = {
		NATS_URL: url,
		PBX_ENSURE_KV_BUCKETS: true,
	} as unknown as PbxEnv;
	const hub = new LiveHub(env);
	await hub.onModuleInit();

	const seeder: NatsConnection = await connect({ servers: url, name: "bench-seed" });
	const manager = await seeder.jetstreamManager();
	const jetstream = manager.jetstream();
	const bucket = await jetstream.views.kv(REGISTRATIONS_KV.name, { history: 1 });
	const encoder = new TextEncoder();
	for (let index = 0; index < KEYS; index += 1) {
		await bucket.put(
			`${ORG}.ext-100${index}`,
			encoder.encode(
				JSON.stringify({
					orgId: ORG,
					aor: `sip:100${index}@bench.test`,
					aorHash: `ext-100${index}`,
					contact: `sip:100${index}@10.0.0.${index % 250}:5060`,
					transport: "udp",
					userAgent: "bench",
					sourceAddress: `10.0.0.${index % 250}:5060`,
					registeredAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					expiresInSeconds: 60,
				}),
			),
		);
	}

	// One untimed pass so the bucket handle and any lazily-created consumer exist.
	await hub.snapshot(ORG, "registrations-kv");

	const samples: number[] = [];
	for (let round = 0; round < ROUNDS; round += 1) {
		const start = process.hrtime.bigint();
		const rows = await hub.snapshot(ORG, "registrations-kv");
		samples.push(Number(process.hrtime.bigint() - start) / 1e6);
		if (rows.length !== KEYS) {
			throw new Error(`snapshot returned ${rows.length} rows, expected ${KEYS}`);
		}
	}
	samples.sort((a, b) => a - b);
	const at = (fraction: number) =>
		samples[Math.min(samples.length - 1, Math.floor(fraction * samples.length))];

	process.stdout.write(
		[
			`keys           ${KEYS}`,
			`rounds         ${ROUNDS}`,
			`p50 ms         ${at(0.5)?.toFixed(1)}`,
			`p99 ms         ${at(0.99)?.toFixed(1)}`,
			`ms/key (p50)   ${((at(0.5) ?? 0) / KEYS).toFixed(3)}`,
			"",
		].join("\n"),
	);

	await hub.onApplicationShutdown();
	await seeder.drain();
	process.exit(0);
}

void main();
