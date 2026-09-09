/**
 * Bench 3 — `SipdCommandClient` request/reply against a fake `apps/sipd` responder.
 *
 * ```sh
 * NATS_SERVER_BIN=/path/to/nats-server bun apps/engine/bench/sipd-rpc.bench.ts
 * ```
 *
 * The responder speaks the BARE contract struct the Go edge speaks, so this exercises the real
 * encode / request / decode / `safeParse` path. It also drives a timeout sweep, because the
 * pending-request map is what a wedged edge grows.
 */
import { connect } from "nats";
import { SIP_RING_RPC, subjectFor } from "@optimiq-voice/events";
import { createEntityId } from "@optimiq-voice/identifiers";
import { SipdCommandClient } from "../src/nats/sipd-command.client";
import { lagSampler, percentiles, startBroker } from "./broker";
import type { NatsConnection } from "nats";

const RATES = (process.env.BENCH_RPC_RATES ?? "500,1000,2000").split(",").map(Number);
const REQUESTS = Number(process.env.BENCH_RPC_REQUESTS ?? 10_000);
const INSTANCE = "edge-1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serveRing(connection: NatsConnection): { stop(): void } {
	const subscription = connection.subscribe(subjectFor.sipRingRpc(INSTANCE), {
		queue: "sipd",
		callback: (_error, message) => {
			const request = JSON.parse(decoder.decode(message.data)) as { legId: string };
			message.respond(
				encoder.encode(JSON.stringify({ ok: true, legId: request.legId, instanceId: INSTANCE })),
			);
		},
	});
	return {
		stop(): void {
			subscription.unsubscribe();
		},
	};
}

async function main(): Promise<void> {
	const broker = await startBroker();
	try {
		const responderConnection = await connect({ servers: broker.url, name: "bench-sipd" });
		const responder = serveRing(responderConnection);
		const engineConnection = await connect({
			servers: broker.url,
			name: "bench-engine",
			inboxPrefix: "_INBOX.engine",
		});
		const client = new SipdCommandClient(() => engineConnection);
		const orgId = createEntityId();

		for (const rate of RATES) {
			const latencies: number[] = [];
			const lag = lagSampler();
			const startedAt = performance.now();
			const perTick = Math.max(1, Math.round(rate / 100));
			let issued = 0;
			let refused = 0;
			while (issued < REQUESTS) {
				const budget = Math.min(perTick, REQUESTS - issued);
				const batch: Promise<void>[] = [];
				for (let index = 0; index < budget; index += 1) {
					const at = performance.now();
					batch.push(
						client
							.ring(INSTANCE, {
								legId: createEntityId(),
								orgId,
								callId: createEntityId(),
							} as never)
							.then((response) => {
								latencies.push(performance.now() - at);
								if (!response.ok) {
									refused += 1;
								}
							}),
					);
				}
				issued += budget;
				await Promise.all(batch);
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			const elapsed = (performance.now() - startedAt) / 1000;
			const loop = lag.stop();
			const { p50, p99, max } = percentiles(latencies);
			console.log(
				`ring target ${String(rate)}/s: ${String(issued)} requests in ${elapsed.toFixed(2)}s ` +
					`(${(issued / elapsed).toFixed(0)}/s) refused ${String(refused)} ` +
					`p50 ${p50.toFixed(3)}ms p99 ${p99.toFixed(3)}ms max ${max.toFixed(2)}ms ` +
					`loop-lag mean ${loop.mean.toFixed(2)}ms rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`,
			);
		}

		// Timeout sweep: no responder at all, so every request waits out `SIP_RING_RPC.timeoutMs`
		// and the client's pending map is at its widest.
		responder.stop();
		const pending = 200;
		const at = performance.now();
		const results = await Promise.all(
			Array.from(
				{ length: pending },
				async () =>
					await client.ring("edge-gone", {
						legId: createEntityId(),
						orgId,
						callId: createEntityId(),
					} as never),
			),
		);
		console.log(
			`timeout sweep: ${String(results.filter((response) => !response.ok).length)}/${String(pending)} refused in ` +
				`${(performance.now() - at).toFixed(0)}ms (contract timeout ${String(SIP_RING_RPC.timeoutMs)}ms) ` +
				`handles ${String((process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length)} ` +
				`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`,
		);

		await engineConnection.close();
		await responderConnection.close();
	} finally {
		broker.stop();
	}
}

await main();
