/**
 * Keyset pagination over a partitioned ledger.
 *
 * ## Why not `offset`
 *
 * `call_legs` is `PARTITION BY RANGE (started_at)` with a monthly cadence, and the reporting
 * default is `(organization_id, started_at DESC)`. `offset 4000` on that shape makes PostgreSQL
 * produce and discard four thousand rows from however many partitions the range touches, on every
 * page, and the cost grows with the page number. Worse, it is not STABLE: a leg that lands while a
 * user is on page 3 shifts every later row down by one, so page 4 re-shows a row page 3 already
 * had and skips one that page 5 will never show. On a billing ledger being read to answer "where
 * did this call go" that is not a performance note, it is a wrong answer.
 *
 * A cursor over `(started_at, id)` is instead an index seek — the leading column of the reporting
 * index is the partition key, so the planner prunes to the partitions the range names and then
 * walks backwards from an exact position. Rows inserted after the first page do not move the
 * position, because the position is a value rather than a count.
 *
 * ## Why the pair, not just `started_at`
 *
 * `started_at` is not unique: a ring group originating four B-legs in the same millisecond is
 * ordinary. Paging on the timestamp alone either repeats those rows or drops them depending on
 * which comparison you pick. `id` is UUID v7 and therefore itself time-ordered, so `(started_at,
 * id)` is a total order that never ties and never contradicts the visible sort.
 *
 * ## Why it is opaque
 *
 * The encoding is base64url of `<iso>|<uuid>`, which is trivially reversible and is not pretending
 * otherwise — it is not a signed token and carries nothing secret (the client already has both
 * values; they are columns of the row it just rendered). It is opaque so that clients treat it as
 * a handle and we can change the sort key without breaking them, not to hide anything. A tampered
 * cursor can only ever move a caller within their OWN tenant's result set: the organization
 * predicate comes from the session and the RLS policy, never from here.
 */

export interface CdrCursor {
	/** The `started_at` of the last row of the previous page. */
	readonly startedAt: Date;
	/** That row's id, breaking ties within the same instant. */
	readonly id: string;
}

const CURSOR_SEPARATOR = "|";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Raised for anything that is not one of our cursors. The caller turns it into a 400. */
export class CdrCursorError extends Error {
	readonly _tag = "CdrCursorError" as const;

	constructor(message: string) {
		super(message);
		this.name = "CdrCursorError";
	}
}

export function encodeCdrCursor(cursor: CdrCursor): string {
	return Buffer.from(
		`${cursor.startedAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`,
		"utf8",
	).toString("base64url");
}

export function decodeCdrCursor(value: string): CdrCursor {
	if (value.length === 0 || value.length > 256) {
		throw new CdrCursorError("empty or oversized");
	}
	let decoded: string;
	try {
		decoded = Buffer.from(value, "base64url").toString("utf8");
	} catch {
		throw new CdrCursorError("not base64url");
	}
	const separator = decoded.indexOf(CURSOR_SEPARATOR);
	if (separator === -1) {
		throw new CdrCursorError("malformed");
	}
	const timestamp = decoded.slice(0, separator);
	const id = decoded.slice(separator + 1);
	const startedAt = new Date(timestamp);
	if (Number.isNaN(startedAt.getTime())) {
		throw new CdrCursorError("unreadable timestamp");
	}
	if (!UUID_PATTERN.test(id)) {
		throw new CdrCursorError("unreadable id");
	}
	return { startedAt, id };
}

/**
 * The cursor for the page that follows `rows`, or `null` when there is no next page.
 *
 * "No next page" is decided by having asked for one more row than the page holds and not getting
 * it — never by `rows.length < limit` alone, which is indistinguishable from a full last page and
 * would leave a "Next" button that returns nothing.
 */
export function nextCursorFrom<T extends { readonly id: string; readonly startedAt: Date }>(
	rows: readonly T[],
	limit: number,
	fetched: number,
): string | null {
	if (fetched <= limit || rows.length === 0) {
		return null;
	}
	const last = rows[rows.length - 1];
	return last === undefined ? null : encodeCdrCursor({ startedAt: last.startedAt, id: last.id });
}
