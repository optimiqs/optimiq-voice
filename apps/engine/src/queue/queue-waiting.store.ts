import { Injectable } from "@nestjs/common";
import { kvKeyFor, queueWaitingRecordSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { isConflict } from "../nats/claim-store";
import { JetStreamService } from "../nats/jetstream.service";
import {
	emptyWaitingRecord,
	isRenewalDue,
	longestWaitMs,
	pruneWaiting,
	putTombstone,
	QUEUE_WAITING_LEASE_MS,
	rankOf,
	removeWaiting,
	takeTombstone,
	upsertWaiting,
} from "./queue-waiting";
import type {
	QueueWaitingJoin,
	QueueWaitingLeave,
	QueueWaitingPort,
	QueueWaitingRefresh,
	QueueWaitingView,
} from "./queue-session";
import type { QueueWaitingEntry, QueueWaitingRecord } from "@optimiq-voice/events";

/**
 * The engine's writer for the `queue-waiting` bucket — one queue's line, shared by every instance.
 *
 * ## Read-modify-compare-and-set, and a retry that re-reads
 *
 * Every mutation reads the record, applies a PURE function from `queue-waiting.ts` to it, and writes
 * against the revision it read. A lost write is not an error and is never retried blindly: it means
 * another instance changed the line between the read and the write, so the retry starts from a fresh
 * read and re-applies the same intent to the newer value. Blind retry would re-insert a caller who
 * had just been removed, or resurrect a claimed tombstone.
 *
 * The retry budget is small and the failure is soft on purpose. A join that cannot be recorded gives
 * the caller an UNKNOWN position, not a refused call: the line is bookkeeping for an announcement
 * and an ordering, and losing it must never cost somebody their place in a queue they have already
 * been answered into.
 *
 * ## Degradation: no bucket configured means a local line, exactly as before
 *
 * The same asymmetry `claim-store.ts` documents and for the same reason. A deployment with no
 * JetStream KV configured is a deployment saying "one instance", and one instance's in-process line
 * IS the whole line — so the fallback is not a degradation there at all, it is the correct answer.
 * A bucket that is configured and unreachable is an outage, and the honest response to it is a
 * position the engine declines to announce rather than one it made up from the callers it happens to
 * be holding. That is the difference from the counter this replaced, which could not tell the two
 * apart and always answered with its own half of the line.
 *
 * ## Why this is not a `ClaimBucket`
 *
 * `ClaimBucket<T>` is the right abstraction for a key ONE process may own: create-to-win, update at a
 * revision, release. This record is jointly held — every instance with a caller in the queue writes
 * to it — so `create` never means "I won", `release` is never right (deleting the key would evict
 * everybody else's callers), and the interesting operation is read-modify-write rather than claim.
 * Reusing the claim vocabulary would have made every call site translate between two meanings of
 * "lost".
 */
@Injectable()
export class QueueWaitingStore implements QueueWaitingPort {
	private readonly logger = getLogger("engine.queue-waiting");
	/** The line when no bucket is configured. Keyed exactly as the bucket is. */
	private readonly local = new Map<string, QueueWaitingRecord>();
	private writes = 0;
	private conflicts = 0;
	private failures = 0;

	constructor(private readonly jetstream: JetStreamService) {}

	get stats(): {
		readonly writes: number;
		readonly conflicts: number;
		readonly failures: number;
	} {
		return { writes: this.writes, conflicts: this.conflicts, failures: this.failures };
	}

	/** Waiting callers across every queue this process can see. `/healthz` reads it. */
	get waitingCount(): number {
		let total = 0;
		for (const record of this.local.values()) {
			total += record.entries.length;
		}
		return total;
	}

	async join(request: QueueWaitingJoin): Promise<QueueWaitingView> {
		return await this.mutate(
			request.orgId,
			request.queueId,
			request.callId,
			request.now,
			(record) => {
				const claimed = request.resumeAllowed
					? takeTombstone(record, request.callerNumber, request.now)
					: { record, tombstone: undefined };
				const tombstone = claimed.tombstone;
				const entry: QueueWaitingEntry = {
					callId: request.callId,
					legId: request.legId,
					// A resumed caller gets their OLD priority back when it was higher. A VIP who was cut
					// off is still a VIP, and the number they rang back on may not be the one that earned
					// them the priority in the first place.
					priority: Math.max(request.priority, tombstone?.priority ?? request.priority),
					joinedAt: tombstone?.joinedAt ?? request.now,
					instanceId: request.instanceId,
					expiresAt: request.now + QUEUE_WAITING_LEASE_MS,
					...(request.callerNumber === undefined ? {} : { callerNumber: request.callerNumber }),
				};
				return {
					next: upsertWaiting(claimed.record, entry, request.now),
					extra: { resumed: tombstone !== undefined, joinedAt: entry.joinedAt },
				};
			},
		);
	}

	/**
	 * Re-reads the line, renewing the lease only when it is due.
	 *
	 * The asymmetry is the whole point of the method: a READ is a point get that conflicts with
	 * nothing, and a WRITE on one key contends with every other waiting caller in the queue. Callers
	 * re-read every poll pass — once a second — and renew every thirty, so a queue with fifty people
	 * holding costs fifty reads a second and under two writes.
	 */
	async refresh(request: QueueWaitingRefresh): Promise<QueueWaitingView> {
		const read = await this.read(request.orgId, request.queueId, request.now);
		if (read === undefined) {
			return UNKNOWN_VIEW;
		}
		const pruned = pruneWaiting(read.record, request.now);
		const entry = pruned.entries.find((candidate) => candidate.callId === request.callId);
		if (entry !== undefined && !isRenewalDue(entry, request.now)) {
			return viewOf(pruned, request.callId, request.now, {
				resumed: false,
				joinedAt: entry.joinedAt,
			});
		}
		// Either the lease is due or the caller has fallen out of the line entirely — a lapsed lease,
		// or a write of ours that lost and was never retried. Both are repaired by writing the entry
		// back, which is why this is an upsert rather than a renewal.
		return await this.mutate(
			request.orgId,
			request.queueId,
			request.callId,
			request.now,
			(record) => {
				const current = record.entries.find((candidate) => candidate.callId === request.callId);
				const renewed: QueueWaitingEntry = {
					...(current ?? {
						callId: request.callId,
						legId: request.legId,
						priority: request.priority,
						joinedAt: request.joinedAt,
						instanceId: request.instanceId,
						...(request.callerNumber === undefined ? {} : { callerNumber: request.callerNumber }),
					}),
					expiresAt: request.now + QUEUE_WAITING_LEASE_MS,
				};
				return {
					next: upsertWaiting(record, renewed, request.now),
					extra: { resumed: false, joinedAt: renewed.joinedAt },
				};
			},
		);
	}

	/**
	 * Takes a caller out of the line, and — for an abandonment inside a resuming queue — holds their
	 * place in the same write.
	 *
	 * One write, not two. A caller who left the line with no promise recorded, or one whose promise
	 * was recorded while they were still in it, are both states a reader would have to handle; making
	 * it a single compare-and-set means neither exists.
	 */
	async leave(request: QueueWaitingLeave): Promise<void> {
		await this.mutate(request.orgId, request.queueId, request.callId, request.now, (record) => {
			const without = removeWaiting(record, request.callId, request.now);
			if (request.tombstone === undefined) {
				return { next: without, extra: { resumed: false, joinedAt: 0 } };
			}
			return {
				next: putTombstone(without, request.tombstone, request.now),
				extra: { resumed: false, joinedAt: request.tombstone.joinedAt },
			};
		});
	}

	// -------------------------------------------------------------------------------------------
	// The bucket
	// -------------------------------------------------------------------------------------------

	private async mutate(
		orgId: string,
		queueId: string,
		callId: string,
		now: number,
		apply: (record: QueueWaitingRecord) => {
			readonly next: QueueWaitingRecord;
			readonly extra: { readonly resumed: boolean; readonly joinedAt: number };
		},
	): Promise<QueueWaitingView> {
		const bucket = this.jetstream.queueWaiting;
		if (bucket === undefined) {
			const key = this.keyOf(orgId, queueId);
			if (key === undefined) {
				return UNKNOWN_VIEW;
			}
			const current = pruneWaiting(
				this.local.get(key) ?? emptyWaitingRecord(orgId, queueId, now),
				now,
			);
			const applied = apply(current);
			this.local.set(key, applied.next);
			this.writes += 1;
			return viewOf(applied.next, callId, now, applied.extra);
		}

		const key = this.keyOf(orgId, queueId);
		if (key === undefined) {
			return UNKNOWN_VIEW;
		}

		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			const read = await this.read(orgId, queueId, now);
			if (read === undefined) {
				return UNKNOWN_VIEW;
			}
			const applied = apply(pruneWaiting(read.record, now));
			const value = new TextEncoder().encode(JSON.stringify(applied.next));
			try {
				if (read.revision === 0) {
					await bucket.create(key, value);
				} else {
					await bucket.update(key, value, read.revision);
				}
				this.writes += 1;
				return viewOf(applied.next, callId, now, applied.extra);
			} catch (error) {
				if (!isConflict(error)) {
					this.failures += 1;
					this.logger.warn(
						{ orgId, queueId, err: String(error) },
						"could not write the queue waiting line; the caller's position is unknown",
					);
					return UNKNOWN_VIEW;
				}
				// Another instance wrote between our read and our write. Start again from THEIR value:
				// re-applying to the stale one would undo whatever they did.
				this.conflicts += 1;
			}
		}

		this.logger.warn(
			{ orgId, queueId, attempts: MAX_CAS_ATTEMPTS },
			"gave up writing the queue waiting line after repeated conflicts",
		);
		return UNKNOWN_VIEW;
	}

	private async read(
		orgId: string,
		queueId: string,
		now: number,
	): Promise<{ readonly record: QueueWaitingRecord; readonly revision: number } | undefined> {
		const bucket = this.jetstream.queueWaiting;
		const key = this.keyOf(orgId, queueId);
		if (key === undefined) {
			return undefined;
		}
		if (bucket === undefined) {
			const record = this.local.get(key) ?? emptyWaitingRecord(orgId, queueId, now);
			return { record, revision: 0 };
		}
		try {
			const entry = await bucket.get(key);
			if (entry === null || entry.value.length === 0) {
				return { record: emptyWaitingRecord(orgId, queueId, now), revision: 0 };
			}
			return {
				record: queueWaitingRecordSchema.parse(JSON.parse(new TextDecoder().decode(entry.value))),
				revision: entry.revision,
			};
		} catch (error) {
			// NOT "the queue is empty". A record that cannot be read or parsed is an unavailability,
			// and starting a fresh line over the top of it would evict every other instance's callers
			// from their places — the one failure mode worse than reporting no position at all.
			this.logger.warn(
				{ orgId, queueId, err: String(error) },
				"discarding an unreadable queue waiting record",
			);
			return undefined;
		}
	}

	private keyOf(orgId: string, queueId: string): string | undefined {
		try {
			return kvKeyFor.queueWaiting(orgId, queueId);
		} catch {
			return undefined;
		}
	}
}

const MAX_CAS_ATTEMPTS = 5;

/** What the session is told when the line could not be read or written. */
const UNKNOWN_VIEW: QueueWaitingView = {
	position: 0,
	waiting: 0,
	longestWaitMs: 0,
	resumed: false,
	joinedAt: 0,
};

function viewOf(
	record: QueueWaitingRecord,
	callId: string,
	now: number,
	extra: { readonly resumed: boolean; readonly joinedAt: number },
): QueueWaitingView {
	return {
		position: rankOf(record, callId, now),
		waiting: record.entries.length,
		longestWaitMs: longestWaitMs(record, now),
		resumed: extra.resumed,
		joinedAt: extra.joinedAt,
	};
}
