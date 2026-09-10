import { registerAsyncGauge } from "./metrics";
import type { NatsConnection } from "nats";

/**
 * JetStream durable-consumer lag, read from the broker at scrape time.
 *
 * ## Why it is polled rather than counted
 *
 * Lag is the broker's fact, not ours: `num_pending` is how many messages the stream holds that
 * this durable has not been delivered. A consumer cannot compute it — it only knows what it has
 * seen — so a counter maintained on this side would report "messages I processed", which is the
 * number that looks healthy in precisely the outage where the consumer has stopped.
 *
 * One `consumers.info` per registered durable per scrape. That is a handful of request/reply round
 * trips a minute against a broker doing tens of thousands, and the alternative — a poll on a timer
 * of its own — is the same cost paid whether or not anybody is looking.
 *
 * ## The failure mode is a stale series, on purpose
 *
 * `registerAsyncGauge` swallows the error, so a broker that is momentarily unreachable leaves the
 * last-known values in place rather than failing the whole scrape. That is the right trade for a
 * lag gauge: the metric that tells you the consumer is behind must not be the one that disappears
 * when the broker is in trouble. The disappearance IS still visible — `api_nats_consumers` counts
 * how many of the registered durables answered.
 */
export interface DurableConsumerRef {
	readonly stream: string;
	readonly durable: string;
}

/**
 * Registered durables, by `stream/durable`, so a consumer that is re-created (a redeploy, a test
 * harness building a second application) does not produce a duplicate series.
 */
const registered = new Map<
	string,
	{ readonly ref: DurableConsumerRef; connection: NatsConnection }
>();

let installed = false;

/** Adds one durable to the scrape, installing the collectors on the first call. */
export function trackDurableConsumer(connection: NatsConnection, ref: DurableConsumerRef): void {
	registered.set(`${ref.stream}/${ref.durable}`, { ref, connection });
	if (installed) {
		return;
	}
	installed = true;

	const labels = ["stream", "durable"] as const;
	registerAsyncGauge(
		"api_nats_consumer_pending",
		"Messages in the stream this durable has not been delivered yet — the consumer's lag.",
		labels,
		async (set) => {
			await forEachConsumer((ref, info) => {
				set({ stream: ref.stream, durable: ref.durable }, info.num_pending ?? 0);
			});
		},
	);
	registerAsyncGauge(
		"api_nats_consumer_ack_pending",
		"Messages delivered to this durable and not yet acknowledged.",
		labels,
		async (set) => {
			await forEachConsumer((ref, info) => {
				set({ stream: ref.stream, durable: ref.durable }, info.num_ack_pending ?? 0);
			});
		},
	);
	registerAsyncGauge(
		"api_nats_consumer_redelivered",
		"Messages this durable has been offered more than once — a NAK loop, or a poison message.",
		labels,
		async (set) => {
			await forEachConsumer((ref, info) => {
				set({ stream: ref.stream, durable: ref.durable }, info.num_redelivered ?? 0);
			});
		},
	);
	registerAsyncGauge(
		"api_nats_consumer_ack_floor",
		"Stream sequence below which this durable has acknowledged everything. It is the ledger's high-water mark: a floor that stops moving while api_nats_consumer_pending climbs is a stalled writer.",
		labels,
		async (set) => {
			await forEachConsumer((ref, info) => {
				set({ stream: ref.stream, durable: ref.durable }, info.ack_floor?.stream_seq ?? 0);
			});
		},
	);
	registerAsyncGauge(
		"api_nats_consumers",
		"Registered durables whose info the broker answered on the last scrape, out of api_nats_consumers_registered.",
		[],
		async (set) => {
			let answered = 0;
			await forEachConsumer(() => {
				answered += 1;
			});
			set({}, answered);
		},
	);
	registerAsyncGauge(
		"api_nats_consumers_registered",
		"Durables this process asked to have scraped.",
		[],
		async (set) => {
			set({}, registered.size);
			await Promise.resolve();
		},
	);
}

/**
 * Asks the broker about every registered durable, in parallel, and calls back for each one that
 * answered.
 *
 * `allSettled` rather than `all`: one durable that has been deleted out from under the process
 * must not take the other durables' numbers off the scrape with it.
 */
async function forEachConsumer(
	visit: (ref: DurableConsumerRef, info: ConsumerInfoShape) => void,
): Promise<void> {
	await Promise.allSettled(
		[...registered.values()].map(async ({ ref, connection }) => {
			const manager = await connection.jetstreamManager();
			const info = (await manager.consumers.info(ref.stream, ref.durable)) as ConsumerInfoShape;
			visit(ref, info);
		}),
	);
}

/**
 * The fields read off `ConsumerInfo`, declared structurally for the reason `durable-consumer.ts`
 * gives for `DurableMessage`: naming the library's type drags its declarations through this app's
 * relaxed `strictNullChecks` for no gain.
 */
interface ConsumerInfoShape {
	readonly num_pending?: number;
	readonly num_ack_pending?: number;
	readonly num_redelivered?: number;
	readonly ack_floor?: { readonly stream_seq?: number };
}

/** Forgets every registered durable. For tests. */
export function resetDurableConsumerTrackingForTest(): void {
	registered.clear();
}
