/**
 * Bench 1 — event publish/consume through the REAL `@optimiq-voice/events` helpers.
 *
 * ```sh
 * NATS_SERVER_BIN=/path/to/nats-server bun apps/engine/bench/events-throughput.bench.ts
 * ```
 *
 * Measures, against a real JetStream broker on loopback:
 *  - `makeCallEvent` + `validateEvent` cost with no broker at all (the CPU floor per event),
 *  - core publish through the engine's own `serializeEnvelopeOnly` at the target rate,
 *  - a JetStream pull consumer draining `CALLS` with `ack()`, end-to-end latency per event.
 */
import { AckPolicy, DeliverPolicy, connect } from "nats";
import {
	CALLS_STREAM,
	ensureStreams,
	makeCallEvent,
	subjectFilterFor,
	validateEvent,
	assertEventSubjectMatches,
} from "@optimiq-voice/events";
import { createEntityId } from "@optimiq-voice/identifiers";
import { serializeEnvelopeOnly } from "../src/nats/envelope.serializer";
import { lagSampler, percentiles, startBroker } from "./broker";
import type { CallEventOf } from "@optimiq-voice/events";

const TOTAL = Number(process.env.BENCH_EVENTS ?? 20_000);
const RATES = (process.env.BENCH_RATES ?? "1000,5000,10000").split(",").map(Number);
const decoder = new TextDecoder();

function envelopeFor(
	orgId: string,
	callId: string,
	legId: string,
): CallEventOf<"channel.answered"> {
	return makeCallEvent("channel.answered", { orgId, callId, source: "engine", data: { legId } });
}

function reportCpuFloor(orgId: string): void {
	const callId = createEntityId();
	const legId = createEntityId();
	// Warm the JIT and zod's lazily-built internals before timing.
	for (let index = 0; index < 2_000; index += 1) {
		validateEvent(envelopeFor(orgId, callId, legId).subject, envelopeFor(orgId, callId, legId));
	}
	const iterations = 50_000;

	let started = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		envelopeFor(orgId, callId, legId);
	}
	const makeUs = ((performance.now() - started) * 1000) / iterations;

	const envelope = envelopeFor(orgId, callId, legId);
	started = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		validateEvent(envelope.subject, envelope);
	}
	const validateUs = ((performance.now() - started) * 1000) / iterations;

	started = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		assertEventSubjectMatches(envelope.subject, envelope);
	}
	const crossCheckUs = ((performance.now() - started) * 1000) / iterations;

	started = performance.now();
	let bytes = 0;
	for (let index = 0; index < iterations; index += 1) {
		bytes += serializeEnvelopeOnly({ pattern: envelope.subject, data: envelope }).data.length;
	}
	const serializeUs = ((performance.now() - started) * 1000) / iterations;

	console.log(
		`cpu-floor per event: makeCallEvent ${makeUs.toFixed(2)}us  validateEvent ${validateUs.toFixed(2)}us  ` +
			`crossCheck ${crossCheckUs.toFixed(2)}us  serialize ${serializeUs.toFixed(2)}us  ` +
			`wire ${(bytes / iterations).toFixed(0)}B`,
	);
}

async function main(): Promise<void> {
	const broker = await startBroker();
	try {
		const orgId = createEntityId();
		reportCpuFloor(orgId);

		const connection = await connect({ servers: broker.url, name: "bench-events" });
		const manager = await connection.jetstreamManager();
		await ensureStreams(manager);
		const jetstream = connection.jetstream();

		for (const rate of RATES) {
			const callId = createEntityId();
			const legId = createEntityId();
			const filter = subjectFilterFor.callsInOrg(orgId);
			const durable = `bench-${String(rate)}-${String(process.pid)}`;
			await manager.consumers.add(CALLS_STREAM.name, {
				durable_name: durable,
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.New,
				filter_subject: filter,
			});
			const consumer = await jetstream.consumers.get(CALLS_STREAM.name, durable);

			const latencies: number[] = [];
			let consumed = 0;
			const drained = (async (): Promise<void> => {
				const messages = await consumer.consume({ max_messages: 512 });
				for await (const message of messages) {
					const envelope = validateEvent(message.subject, JSON.parse(decoder.decode(message.data)));
					latencies.push(Date.now() - Date.parse(envelope.at));
					message.ack();
					consumed += 1;
					if (consumed >= TOTAL) {
						break;
					}
				}
				messages.stop();
			})();

			const lag = lagSampler();
			const startedAt = performance.now();
			const perTick = Math.max(1, Math.round(rate / 100));
			let published = 0;
			while (published < TOTAL) {
				const budget = Math.min(perTick, TOTAL - published);
				for (let index = 0; index < budget; index += 1) {
					const envelope = envelopeFor(orgId, callId, legId);
					assertEventSubjectMatches(envelope.subject, envelope);
					connection.publish(envelope.subject, serializeEnvelopeOnly({ data: envelope }).data);
				}
				published += budget;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await connection.flush();
			await drained;
			const elapsed = (performance.now() - startedAt) / 1000;
			const loop = lag.stop();
			const { p50, p99, max } = percentiles(latencies);
			console.log(
				`target ${String(rate)}/s: published ${String(published)} consumed ${String(consumed)} in ` +
					`${elapsed.toFixed(2)}s (${(published / elapsed).toFixed(0)}/s) ` +
					`latency p50 ${String(p50)}ms p99 ${String(p99)}ms max ${String(max)}ms ` +
					`loop-lag mean ${loop.mean.toFixed(2)}ms max ${loop.max.toFixed(2)}ms ` +
					`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`,
			);
			await manager.consumers.delete(CALLS_STREAM.name, durable);
		}
		await connection.close();
	} finally {
		broker.stop();
	}
}

await main();
