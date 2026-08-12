import { QUEUE_WAITING_MAX_ENTRIES, QUEUE_WAITING_MAX_TOMBSTONES } from "@optimiq-voice/events";
import type {
	QueueResumeTombstone,
	QueueWaitingEntry,
	QueueWaitingRecord,
} from "@optimiq-voice/events";

/**
 * The waiting line: who is in a queue, in what order, and whose place is being held.
 *
 * ## Pure, on the same terms as `queue-strategy.ts`
 *
 * Nothing here talks to KV, to a clock or to a media server. Every function takes a record and a
 * `now` and returns a new record or an answer. That split is what makes "does a resumed caller land
 * ahead of somebody who joined while they were gone?" a four-line test rather than a cluster.
 * `queue-waiting.store.ts` is the thin half that reads, applies one of these, and writes back under
 * compare-and-set.
 *
 * ## The order, and why it is exactly these three keys
 *
 * `(priority DESC, joinedAt ASC, callId ASC)`.
 *
 * - **Priority first** is what "higher priority dequeues first" means, and it has to be first or it
 *   is not a priority — a scheme that only broke ties by priority would leave a VIP behind whoever
 *   happened to arrive a second earlier.
 * - **`joinedAt` second** is FIFO within a priority, which is what a caller believes is happening
 *   and the only fair reading of "you are number four".
 * - **`callId` third** is the tie-break, and it is not decoration. Two callers can join in the same
 *   millisecond — two instances writing in one CAS round is the normal case at the top of the hour —
 *   and without a total order the rank of each would depend on the array order the record happened
 *   to be written in, so two engines reading one record would disagree about who is next. Every
 *   ordering in this codebase that must be stable across processes ends in an id for the same
 *   reason; see `compareByTier`.
 *
 * ## Starvation: strict priority, argued
 *
 * There is no ageing. A stream of priority-900 callers will hold a priority-0 caller at the back of
 * the line indefinitely, and that is the intended behaviour rather than an oversight.
 *
 * The alternative — adding `floor(waitedMs / step)` to the effective priority — makes the order
 * unpredictable in exactly the situation the feature exists for. An operator who sets platinum to
 * 800 is buying "platinum is answered first"; under ageing they get "platinum is answered first
 * unless somebody has been holding for eleven minutes", which is a rule nobody can explain to the
 * customer who was overtaken, and whose threshold has to be tuned per queue against a traffic mix
 * that changes hourly. Priority that sometimes does not apply is worse than either priority or no
 * priority.
 *
 * What bounds the starvation is not ageing, it is the deadline the queue already has.
 * `maxWaitSeconds` and `maxWaitNoAgentSeconds` are absolute and are checked before any of this: a
 * starved caller is EJECTED to the queue's timeout destination — voicemail, an overflow queue, a
 * callback IVR — rather than being held forever. That is a better answer than a slow answer, it is
 * configurable per queue by the operator who chose to use priorities, and it is the answer the queue
 * already gives to a caller nobody is free to take.
 *
 * The seam, if a deployment ever genuinely needs ageing, is one function: {@link effectivePriority}
 * is the only place the comparator reads a priority from, so an ageing rule is a change to it plus
 * two columns. It is deliberately not taken now, because the argument above says it should not be.
 *
 * ## Leases, and who prunes
 *
 * A record is one KV key, so per-caller server-side expiry does not exist (see `QUEUE_WAITING_KV`).
 * Each entry therefore carries `expiresAt`, its owning session pushes that forward while the caller
 * is really still holding, and {@link pruneWaiting} drops the lapsed ones. Every writer prunes on its
 * way past rather than a reaper doing it: pruning is free inside a write that is happening anyway,
 * and a dedicated reaper would be a second process that has to be running for positions to be
 * correct.
 *
 * The direction of the failure matters and is the reason the lease is generous. Dropping a LIVE
 * caller from the line makes every caller behind them think they are one place further forward than
 * they are, and drops the dropped caller's own place entirely; keeping a DEAD caller for another
 * minute makes everybody think they are one place further back. The second is the mistake to make,
 * so the lease is many poll intervals long.
 */

/** How long an entry's lease runs, and how much of it may pass before a session renews. */
export const QUEUE_WAITING_LEASE_MS = 90_000;
export const QUEUE_WAITING_RENEW_AFTER_MS = 30_000;

/**
 * The priority the comparator sorts on.
 *
 * A function of one line rather than a field read, because it is the single seam an ageing rule
 * would go through — see the starvation note on this module. It takes `now` it does not use for
 * exactly that reason: a caller who added ageing would not have to change the comparator.
 */
export function effectivePriority(entry: QueueWaitingEntry, _now: number): number {
	return entry.priority;
}

/** `(priority DESC, joinedAt ASC, callId ASC)`. A total order, so two engines cannot disagree. */
export function compareWaiting(
	left: QueueWaitingEntry,
	right: QueueWaitingEntry,
	now: number,
): number {
	const leftPriority = effectivePriority(left, now);
	const rightPriority = effectivePriority(right, now);
	if (leftPriority !== rightPriority) {
		return rightPriority - leftPriority;
	}
	if (left.joinedAt !== right.joinedAt) {
		return left.joinedAt - right.joinedAt;
	}
	return left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0;
}

export function emptyWaitingRecord(
	orgId: string,
	queueId: string,
	now: number,
): QueueWaitingRecord {
	return { orgId, queueId, entries: [], tombstones: [], updatedAt: now };
}

/** Drops every entry and tombstone whose lease has lapsed. Idempotent, and safe to run always. */
export function pruneWaiting(record: QueueWaitingRecord, now: number): QueueWaitingRecord {
	const entries = record.entries.filter((entry) => entry.expiresAt > now);
	const tombstones = record.tombstones.filter((tombstone) => tombstone.expiresAt > now);
	if (entries.length === record.entries.length && tombstones.length === record.tombstones.length) {
		return record;
	}
	return { ...record, entries, tombstones };
}

/** The line in served order. Callers ahead of a given entry are the ones before it here. */
export function orderedWaiting(
	record: QueueWaitingRecord,
	now: number,
): readonly QueueWaitingEntry[] {
	return [...record.entries].sort((left, right) => compareWaiting(left, right, now));
}

/**
 * A caller's 1-based position, or 0 when the line does not hold them.
 *
 * 0 rather than 1 for an absent caller, unlike the in-process counter this replaced. That counter
 * reported 1 because it had no way to tell "not in my map" from "at the front" and 1 was the least
 * alarming guess. Here the record IS the line, so absence is a real answer — the caller's entry
 * lapsed, or the write that should have added them lost — and reporting it as 0 lets the session
 * decline to announce a position rather than announcing a wrong one. A caller told nothing is better
 * served than a caller told "you are next" four times in a row.
 */
export function rankOf(record: QueueWaitingRecord, callId: string, now: number): number {
	const ordered = orderedWaiting(record, now);
	const index = ordered.findIndex((entry) => entry.callId === callId);
	return index < 0 ? 0 : index + 1;
}

/** Adds or replaces a caller's entry. Replacing is how a lease renewal is expressed. */
export function upsertWaiting(
	record: QueueWaitingRecord,
	entry: QueueWaitingEntry,
	now: number,
): QueueWaitingRecord {
	const others = record.entries.filter((candidate) => candidate.callId !== entry.callId);
	if (others.length >= QUEUE_WAITING_MAX_ENTRIES) {
		// The line is full. The caller is still SERVED — they simply have no shared position, and
		// the session reports that as unknown rather than as first. Refusing the call over a
		// bookkeeping cap would be the wrong way round by a very long way.
		return { ...record, entries: others, updatedAt: now };
	}
	return { ...record, entries: [...others, entry], updatedAt: now };
}

export function removeWaiting(
	record: QueueWaitingRecord,
	callId: string,
	now: number,
): QueueWaitingRecord {
	const entries = record.entries.filter((entry) => entry.callId !== callId);
	if (entries.length === record.entries.length) {
		return record;
	}
	return { ...record, entries, updatedAt: now };
}

/**
 * Records a resume promise for a caller who gave up.
 *
 * One tombstone per number: a caller who abandons twice inside one window replaces their own
 * promise rather than accumulating two, and the replacement carries the EARLIER `joinedAt` because
 * that is the place they are owed. Without that, abandoning a second time would quietly cost a
 * caller the position their first abandonment was holding for them.
 */
export function putTombstone(
	record: QueueWaitingRecord,
	tombstone: QueueResumeTombstone,
	now: number,
): QueueWaitingRecord {
	const existing = record.tombstones.find(
		(candidate) => candidate.callerNumber === tombstone.callerNumber,
	);
	const others = record.tombstones.filter(
		(candidate) => candidate.callerNumber !== tombstone.callerNumber,
	);
	if (others.length >= QUEUE_WAITING_MAX_TOMBSTONES) {
		return { ...record, tombstones: others, updatedAt: now };
	}
	const merged: QueueResumeTombstone =
		existing === undefined || existing.joinedAt >= tombstone.joinedAt
			? tombstone
			: {
					...tombstone,
					joinedAt: existing.joinedAt,
					priority: Math.max(existing.priority, tombstone.priority),
				};
	return { ...record, tombstones: [...others, merged], updatedAt: now };
}

/**
 * Claims the promise held for a number, if there is a live one.
 *
 * The tombstone is REMOVED by this call, in the record the caller is about to be inserted into, so
 * the claim and the insertion are one compare-and-set. A tombstone that survived being claimed would
 * let one abandoned call buy the same number an unlimited number of line-jumps for the rest of the
 * window — a priority bypass anybody could dial.
 */
export function takeTombstone(
	record: QueueWaitingRecord,
	callerNumber: string | undefined,
	now: number,
): { readonly record: QueueWaitingRecord; readonly tombstone?: QueueResumeTombstone } {
	if (callerNumber === undefined || callerNumber === "") {
		return { record };
	}
	const tombstone = record.tombstones.find(
		(candidate) => candidate.callerNumber === callerNumber && candidate.expiresAt > now,
	);
	if (tombstone === undefined) {
		return { record };
	}
	return {
		record: {
			...record,
			tombstones: record.tombstones.filter((candidate) => candidate !== tombstone),
			updatedAt: now,
		},
		tombstone,
	};
}

/** Whether an entry is close enough to its expiry that its owner should push the lease forward. */
export function isRenewalDue(entry: QueueWaitingEntry, now: number): boolean {
	return entry.expiresAt - now <= QUEUE_WAITING_LEASE_MS - QUEUE_WAITING_RENEW_AFTER_MS;
}

/** How long the caller at the front has been holding. The wallboard's "longest wait". */
export function longestWaitMs(record: QueueWaitingRecord, now: number): number {
	let longest = 0;
	for (const entry of record.entries) {
		longest = Math.max(longest, now - entry.joinedAt);
	}
	return Math.max(0, longest);
}
