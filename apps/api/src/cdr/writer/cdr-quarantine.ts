import { cdrWriteQuarantine } from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logger";
import type { CdrDatabaseClient, CdrQuarantineReason } from "@optimiq-voice/cdr-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The writers' dead-letter sink.
 *
 * ## Why terminate-and-record rather than nak-forever
 *
 * A durable consumer with `max_deliver: n` redelivers a failing message n times and then stops
 * offering it. Whatever the number is, the message is not gone — the `CDR` stream is
 * `retention: limits`, so acking never deletes anything and every message is still addressable by
 * sequence for thirty days — but nothing will hand it to the writer again. So the choice is not
 * "drop it or keep it", it is "know which ones stopped, or find out from a customer".
 *
 * This records that. `stream` + `streamSequence` is the address a replay reads from, and `payload`
 * keeps a copy so the diagnosis outlives the stream's retention window.
 *
 * ## Which failures land here, and why the reasons are separate
 *
 * - `unreadable` / `foreign-subject` — terminated on the FIRST delivery, because bytes that are
 *   not this contract will never become this contract, and a redelivery loop on one bad message
 *   blocks every good one behind it. This is the same call `voicemail-consumer.service.ts` makes.
 * - `rejected` — PostgreSQL refused the row. Terminated too: a check-constraint violation is
 *   deterministic, so the eleventh attempt fails exactly like the first. The mapper exists to make
 *   this rare; when it happens it means the mapper has a gap, and the row here is the bug report.
 * - `exhausted` — the writer NAKed it until `max_deliver` ran out. Almost always the database was
 *   the problem, so this is the one worth replaying unchanged once it is healthy.
 *
 * ## Quarantining is best-effort, and that is deliberate
 *
 * If the reason the message failed is "the CDR database is unreachable", the quarantine insert
 * fails too. It is therefore wrapped and logged rather than thrown: a failure to RECORD a failure
 * must not turn into a second exception that stops the consume loop, which would convert one lost
 * message into a stopped writer. The log line is the fallback of last resort and carries the same
 * fields, so `stream`/`sequence` is recoverable from the log even when the table is not reachable.
 */

export interface QuarantineEntry {
	readonly stream: string;
	readonly subject: string;
	readonly streamSequence?: number | undefined;
	readonly deliveryCount: number;
	readonly reason: CdrQuarantineReason;
	readonly detail: string;
	readonly organizationId?: string | undefined;
	readonly payload?: unknown;
}

/** The delivered bytes as something jsonb will accept, whatever they actually were. */
function asJsonPayload(payload: unknown): Record<string, unknown> {
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		return payload as Record<string, unknown>;
	}
	// A non-object body (a bare string, a truncated buffer) still has to be kept — wrapping is the
	// only way jsonb will take it, and the wrapper is named so it reads as "this was not an object".
	return { _nonObjectBody: payload === undefined ? null : String(payload).slice(0, 8192) };
}

export async function quarantineMessage(
	database: CdrDatabaseClient,
	entry: QuarantineEntry,
): Promise<void> {
	logger.error("quarantining a CDR message", {
		stream: entry.stream,
		subject: entry.subject,
		sequence: entry.streamSequence,
		reason: entry.reason,
		deliveries: entry.deliveryCount,
		detail: entry.detail,
	});
	try {
		await database.adminDb.insert(cdrWriteQuarantine).values({
			organizationId: entry.organizationId ?? null,
			stream: entry.stream,
			subject: entry.subject,
			streamSequence: entry.streamSequence ?? null,
			deliveryCount: Math.max(1, entry.deliveryCount),
			reason: entry.reason,
			detail: entry.detail.slice(0, 2048),
			payload: asJsonPayload(entry.payload),
		});
	} catch (error) {
		logger.error("could not record a quarantined CDR message; the log line above is the record", {
			stream: entry.stream,
			subject: entry.subject,
			sequence: entry.streamSequence,
			error,
		});
	}
}
