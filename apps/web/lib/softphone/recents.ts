/**
 * The softphone's recent calls, from the CDR the platform already writes.
 *
 * There is no separate call-history store and there should not be: `call_legs` is the record, and
 * `GET /api/v1/cdr?extension=<mine>` is the query. What this module does is the reduction the phone
 * needs and the report does not — one row per PERSON, most recent first, with the number the
 * Call button will dial.
 *
 * The interesting part, and the reason this is pure and tested: a single two-party call writes
 * SEVERAL legs (the A-leg, the answered B-leg, and one per unanswered fan-out target). A recents
 * list built from raw legs shows the same colleague three times for one call. So legs are collapsed
 * on the peer number, keeping the newest occurrence and the best disposition seen for it.
 */

import type { CallLegRow } from "../cdr/contracts";

export interface RecentCall {
	/** The leg id of the newest occurrence — a stable React key. */
	readonly id: string;
	/** The other party's number, and what Redial dials. */
	readonly number: string;
	readonly name: string | null;
	/** From THIS extension's point of view: did we place it, or take it? */
	readonly direction: "in" | "out";
	/** ISO timestamp of the newest occurrence. */
	readonly at: string;
	/** True when at least one leg to this peer was answered. */
	readonly answered: boolean;
}

/**
 * The other party on a leg, seen from `extension`.
 *
 * A leg where neither end is us is not this user's call and is dropped rather than guessed at —
 * the CDR filter is `extension=`, which matches either side, so a supervised or bridged leg can
 * legitimately arrive here.
 */
function peerOf(
	row: CallLegRow,
	extension: string,
): { number: string; name: string | null } | null {
	if (row.fromNumber === extension) {
		return { number: row.toNumber, name: null };
	}
	if (row.toNumber === extension) {
		return { number: row.fromNumber, name: row.fromName };
	}
	return null;
}

/**
 * Collapse the CDR page into a recents list.
 *
 * `rows` is expected newest-first (the API's own order). Order is preserved rather than re-sorted:
 * the server's `started_at DESC` is the index it pages on, and re-sorting a page here would only
 * disagree with the next page.
 */
export function recentCalls(
	rows: readonly CallLegRow[],
	extension: string,
	limit = 8,
): readonly RecentCall[] {
	const byNumber = new Map<string, RecentCall>();
	for (const row of rows) {
		const peer = peerOf(row, extension);
		if (peer === null || peer.number.length === 0) {
			continue;
		}
		const answered = row.answeredAt !== null;
		const existing = byNumber.get(peer.number);
		if (existing) {
			// Same person, earlier leg of the same (or an older) call: keep the newest entry and only
			// let a later leg upgrade "missed" to "answered", never the other way round.
			if (answered && !existing.answered) {
				byNumber.set(peer.number, { ...existing, answered: true });
			}
			continue;
		}
		byNumber.set(peer.number, {
			id: row.id,
			number: peer.number,
			name: peer.name,
			direction: row.fromNumber === extension ? "out" : "in",
			at: row.startedAt,
			answered,
		});
	}
	return [...byNumber.values()].slice(0, limit);
}
