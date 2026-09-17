/**
 * Bench 4 — a synthetic call storm over the engine's real NATS surface.
 *
 * ```sh
 * NATS_SERVER_BIN=/path/to/nats-server bun apps/engine/bench/call-storm.bench.ts
 * ```
 *
 * Each synthetic leg walks the NATS work one real inbound call does, with the real classes:
 * `JetStreamService.claimChannel` → `SipdCommandClient.ring` → `persistChannel` →
 * `SipdCommandClient.answer` → `persistChannel` → four `CallEventPublisher`-shaped core publishes
 * (`makeCallEvent` + `validateEvent` + `serializeEnvelopeOnly`) → `hangup` → `publishCdrLeg`
 * (acked) → `deleteChannel`. The ownership-maintenance tick runs concurrently, as it does in
 * production.
 *
 * It deliberately does NOT construct `ChannelOrchestrator`: that needs twenty-six collaborators
 * and would measure the spec harness's fakes as much as the network. What is measured here is the
 * part the network owns — round trips per call, bytes encoded and decoded, zod cost, event-loop
 * lag, and heap/handles at steady state and after teardown.
 */
import { connect } from "nats";
import {
	assertEventSubjectMatches,
	makeCallEvent,
	makeCdrLegWriteEvent,
	subjectFor,
	validateEvent,
} from "@optimiq-voice/events";
import { createEntityId } from "@optimiq-voice/identifiers";
import { loadEngineEnv } from "../src/config/engine-env";
import { serializeEnvelopeOnly } from "../src/nats/envelope.serializer";
import { JetStreamService } from "../src/nats/jetstream.service";
import { SipdCommandClient } from "../src/nats/sipd-command.client";
import { lagSampler, percentiles, startBroker } from "./broker";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";
import type { NatsConnection } from "nats";

const CONCURRENCY = Number(process.env.BENCH_LEGS ?? 300);
const CALLS = Number(process.env.BENCH_CALLS ?? 3_000);
const INSTANCE = "edge-1";
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
/**
 * `full` re-parses each envelope with `validateEvent` the way the publisher used to; anything else
 * uses `assertEventSubjectMatches`, which is what it does now. Kept as a switch so the before/after
 * in `audit/NET-engine-nats.md` can be reproduced on one machine in one sitting.
 */
const FULL_VALIDATE = process.env.BENCH_VALIDATE === "full";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let wireOut = 0;
let wireIn = 0;

function serveSipd(connection: NatsConnection): void {
	for (const subject of [
		subjectFor.sipRingRpc(INSTANCE),
		subjectFor.sipAnswerRpc(INSTANCE),
		subjectFor.sipHangupRpc(INSTANCE),
	]) {
		connection.subscribe(subject, {
			queue: "sipd",
			callback: (_error, message) => {
				wireIn += message.data.length;
				const request = JSON.parse(decoder.decode(message.data)) as { legId: string };
				const reply = encoder.encode(
					JSON.stringify({ ok: true, legId: request.legId, instanceId: INSTANCE }),
				);
				wireOut += reply.length;
				message.respond(reply);
			},
		});
	}
}

function snapshotFor(callId: string, state: string): ChannelSnapshot {
	return {
		organizationId: ORG_ID,
		callId,
		channelId: callId,
		ariChannelId: `ari-${callId}`,
		state,
		direction: "inbound",
		leg: "a",
		from: { number: "+15550001111" },
		to: { number: "+15550002222" },
		createdAt: new Date().toISOString(),
		variables: {},
	} as unknown as ChannelSnapshot;
}

async function main(): Promise<void> {
	const broker = await startBroker();
	try {
		const sipd = await connect({ servers: broker.url, name: "bench-sipd" });
		serveSipd(sipd);

		const env = loadEngineEnv({
			NATS_URL: broker.url,
			ENGINE_ENSURE_STREAMS: "true",
			ENGINE_INSTANCE_ID: "bench-engine",
			ARI_PASSWORD: "bench",
		} as Readonly<Record<string, string>>);
		const jetstream = new JetStreamService(env);
		await jetstream.onModuleInit();
		const raw = jetstream.rawConnection!;
		const client = new SipdCommandClient(() => raw);

		let roundTrips = 0;
		let publishBytes = 0;
		const perCall: number[] = [];

		const publish = (
			type: "channel.created" | "channel.ringing" | "channel.answered" | "channel.hangup",
			callId: string,
			legId: string,
			data: unknown,
		): void => {
			const envelope = makeCallEvent(type, {
				orgId: ORG_ID,
				callId,
				source: "engine",
				data: data as never,
			});
			if (FULL_VALIDATE) {
				validateEvent(envelope.subject, envelope);
			} else {
				assertEventSubjectMatches(envelope.subject, envelope);
			}
			const frame = serializeEnvelopeOnly({ data: envelope }).data;
			publishBytes += frame.length;
			raw.publish(envelope.subject, frame);
		};

		const oneCall = async (): Promise<void> => {
			const callId = createEntityId();
			const legId = callId;
			const at = performance.now();
			await jetstream.claimChannel(snapshotFor(callId, "ringing"));
			roundTrips += 1;
			publish("channel.created", callId, legId, {
				legId,
				leg: "a",
				direction: "inbound",
				from: { number: "+15550001111" },
				to: { number: "+15550002222" },
			});
			await client.ring(INSTANCE, { legId, orgId: ORG_ID, callId } as never);
			roundTrips += 1;
			publish("channel.ringing", callId, legId, { legId });
			await jetstream.persistChannel(snapshotFor(callId, "ringing"));
			roundTrips += 1;
			await client.answer(INSTANCE, { legId, orgId: ORG_ID, callId, sdp: "v=0" } as never);
			roundTrips += 1;
			publish("channel.answered", callId, legId, { legId });
			await jetstream.persistChannel(snapshotFor(callId, "up"));
			roundTrips += 1;
			await client.hangup(INSTANCE, { legId, orgId: ORG_ID, callId, cause: "normal" } as never);
			roundTrips += 1;
			publish("channel.hangup", callId, legId, {
				legId,
				cause: "NORMAL_CLEARING",
				causeCode: 16,
				side: "caller",
			});
			await jetstream.publishCdrLeg(
				makeCdrLegWriteEvent({
					orgId: ORG_ID,
					source: "engine",
					data: {
						id: createEntityId(),
						legId,
						callId,
						organizationId: ORG_ID,
						direction: "inbound",
						leg: "a",
						fromNumber: "+15550001111",
						toNumber: "+15550002222",
						destinationType: "extension",
						startedAt: new Date().toISOString(),
						endedAt: new Date().toISOString(),
						durationMs: 1_000,
						billsecMs: 1_000,
						hangupCause: "NORMAL_CLEARING",
						hangupCauseCode: 16,
						disposition: "answered",
					} as never,
				}),
			);
			roundTrips += 1;
			await jetstream.deleteChannel(snapshotFor(callId, "destroyed"));
			roundTrips += 1;
			perCall.push(performance.now() - at);
		};

		const maintenance = setInterval(() => {
			void (async (): Promise<void> => {
				let seen = 0;
				for await (const snapshot of jetstream.channelSnapshots()) {
					seen += snapshot.channelId.length > 0 ? 1 : 0;
				}
			})();
		}, env.ENGINE_CLAIM_HEARTBEAT_MS);

		const lag = lagSampler();
		const startedAt = performance.now();
		let started = 0;
		const workers = Array.from({ length: CONCURRENCY }, async () => {
			while (started < CALLS) {
				started += 1;
				await oneCall();
			}
		});
		await Promise.all(workers);
		const elapsed = (performance.now() - startedAt) / 1000;
		clearInterval(maintenance);
		const loop = lag.stop();
		const { p50, p99, max } = percentiles(perCall);
		const steady = process.memoryUsage();
		const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
			.length;

		console.log(
			`[validate=${FULL_VALIDATE ? "full" : "cross-check"}] ${String(CALLS)} calls at ${String(CONCURRENCY)} concurrent legs in ${elapsed.toFixed(2)}s ` +
				`(${(CALLS / elapsed).toFixed(0)} calls/s)\n` +
				`  per-call: ${(roundTrips / CALLS).toFixed(1)} NATS round trips, ` +
				`${(publishBytes / CALLS).toFixed(0)}B events published, ` +
				`${((wireIn + wireOut) / CALLS).toFixed(0)}B rpc on the wire\n` +
				`  latency p50 ${p50.toFixed(2)}ms p99 ${p99.toFixed(2)}ms max ${max.toFixed(2)}ms\n` +
				`  loop-lag mean ${loop.mean.toFixed(2)}ms max ${loop.max.toFixed(2)}ms  ` +
				`heap ${(steady.heapUsed / 1e6).toFixed(0)}MB rss ${(steady.rss / 1e6).toFixed(0)}MB handles ${String(handles)}`,
		);

		await jetstream.onApplicationShutdown();
		await sipd.close();
		Bun.gc(true);
		const after = process.memoryUsage();
		console.log(
			`  after teardown: heap ${(after.heapUsed / 1e6).toFixed(0)}MB rss ${(after.rss / 1e6).toFixed(0)}MB ` +
				`handles ${String((process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length)}`,
		);
	} finally {
		broker.stop();
	}
}

await main();
