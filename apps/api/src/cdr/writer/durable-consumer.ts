import { AckPolicy, DeliverPolicy } from "nats";
import { getLogger } from "@optimiq-voice/logger";
import type { NatsConnection } from "nats";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The bits of JetStream both CDR writers need, in one place.
 *
 * `voicemail-consumer.service.ts` is the precedent for the SHAPE of a durable consumer in this
 * app — named durable, `DeliverPolicy.All`, explicit ack, insert-then-ack — and this area needs
 * two of them (legs from `CDR`, recordings from `CALLS`). Copying that class twice would be two
 * copies of the connect/ensure/consume dance and two places for the ack ordering to be got wrong,
 * so the dance lives here and each writer supplies only what it does with a message.
 */

/**
 * The message surface a handler is given.
 *
 * Declared structurally rather than as `JsMsg` for the reason the voicemail consumer records:
 * naming the library's types here drags declarations through `apps/api`'s partially-relaxed
 * `strictNullChecks` in ways that are noise rather than signal. It is the exact subset the
 * handlers touch, so nothing is being hidden.
 */
export interface DurableMessage {
	readonly subject: string;
	readonly data: Uint8Array;
	/** Stream sequence — the address a replay of THIS message reads from. */
	readonly seq: number;
	readonly info: {
		/** 1 on first delivery. Compared against the consumer's `max_deliver`. */
		readonly redeliveryCount: number;
	};
	ack(): void;
	nak(millis?: number): void;
	term(): void;
}

export interface DurableConsumerSpec {
	readonly streamName: string;
	readonly durable: string;
	readonly filterSubject: string;
	/**
	 * How many times a NAKed message is redelivered before JetStream stops offering it.
	 *
	 * Five, not the voicemail consumer's ten, and the difference is on purpose: a NAK here means
	 * the CDR database refused or was unreachable, and five attempts with the backoff below spans
	 * about a minute — long enough to ride out a failover, short enough that a genuinely poisoned
	 * message reaches the quarantine while an operator is still looking at the incident rather
	 * than an hour later.
	 */
	readonly maxDeliver: number;
}

/**
 * Creates the durable if it is missing, tolerating the race and the redeploy.
 *
 * `consumers.add` with an identical config on an existing durable is a no-op, so the only error
 * worth reporting is one that is not "it already exists" — anything else means the consumer cannot
 * run, and saying so once at boot beats a silent loop that consumes nothing.
 */
export async function ensureDurableConsumer(
	connection: NatsConnection,
	spec: DurableConsumerSpec,
): Promise<void> {
	try {
		const manager = await connection.jetstreamManager();
		await manager.consumers.add(spec.streamName, {
			durable_name: spec.durable,
			ack_policy: AckPolicy.Explicit,
			/**
			 * `DeliverPolicy.All`, so a durable that does not exist yet starts at the beginning of
			 * the stream rather than at its head.
			 *
			 * For the CDR that is not a convenience, it is the "replay = rebuild" property the stream
			 * was designed around: the first time this writer is deployed against a broker that has
			 * been collecting legs, it files all of them. `discard: new` and a thirty-day window are
			 * precisely what make that a safe thing to want.
			 */
			deliver_policy: DeliverPolicy.All,
			filter_subject: spec.filterSubject,
			max_deliver: spec.maxDeliver,
		});
	} catch (error) {
		if (!/consumer already exists/iu.test(String(error))) {
			logger.error("could not create a CDR durable consumer", {
				stream: spec.streamName,
				durable: spec.durable,
				error,
			});
		}
	}
}

/**
 * Whether an error is PostgreSQL refusing the DATA rather than being unavailable.
 *
 * Class 22 (data exception) and class 23 (integrity constraint violation) are deterministic: the
 * same bytes will be refused the same way on every redelivery, so retrying is only a way to spend
 * five deliveries arriving at the same place. Everything else — a dropped connection, a lock
 * timeout, a failover — is transient and worth a NAK.
 *
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose own message is just the failed SQL,
 * so the code has to be found by walking the cause chain (the same walk
 * `cdr-integration-database.ts` needs for its assertions).
 */
export function isDeterministicDatabaseRejection(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
		const code = (current as { readonly code?: unknown }).code;
		if (typeof code === "string" && (code.startsWith("22") || code.startsWith("23"))) {
			return true;
		}
		current = (current as { readonly cause?: unknown }).cause;
	}
	return false;
}

/** The full cause chain as one line, for a quarantine row's `detail`. */
export function describeError(error: unknown): string {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
		messages.push(current.message);
		current = (current as { readonly cause?: unknown }).cause;
	}
	return messages.length > 0 ? messages.join(" | ") : String(error);
}

/**
 * Redelivery backoff, in millis, by attempt.
 *
 * Linear rather than exponential and capped at 30s: the failure this is riding out is a database
 * restart or a failover, which resolves in seconds, and an exponential curve would have the fifth
 * attempt land minutes after the incident ended — turning a recoverable message into a quarantined
 * one for no reason.
 */
export function redeliveryDelayMs(attempt: number): number {
	return Math.min(30_000, 2_000 * Math.max(1, attempt));
}
