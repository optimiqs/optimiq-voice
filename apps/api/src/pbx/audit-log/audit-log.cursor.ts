/**
 * Keyset pagination over the change ledger.
 *
 * ## Why not `offset`, when every other PBX list uses it
 *
 * The PBX area's lists return `{ data, total, page, limit, totalPages }` and that envelope is
 * right for what it covers: `extension`, `queue`, `inbound_route` are CONFIGURATION — hundreds of
 * rows, counted for free, and changing at human speed. `audit_log` is neither. It takes a row for
 * every mutation in the tenant, forever, and it is read newest-first.
 *
 * Both halves of `offset` break on that shape:
 *
 * 1. **Cost.** `offset 4000` makes PostgreSQL produce and discard four thousand rows on every
 *    page, and the cost grows with the page number. `total` is worse — a `count(*)` over the
 *    whole window, paid again on every page.
 * 2. **Correctness.** It is not STABLE. One mutation lands while an operator is on page 3 and
 *    every later row shifts down by one: page 4 re-shows a row page 3 already had and skips one
 *    page 5 will never show. On the artifact somebody is reading to answer "who turned outbound
 *    calling off?", that is not a performance note. It is a missing row in an investigation.
 *
 * So this follows the reporting area's precedent (`cdr/query/cdr-cursor.ts`) rather than the PBX
 * area's: a cursor over `(occurred_at, id)` is an index seek that walks backwards from an exact
 * POSITION, and a row inserted after the first page cannot move a position that is a value.
 *
 * ## Why this is a copy of `cdr-cursor.ts` and not an import of it
 *
 * They are the same idea over different columns (`started_at` there, `occurred_at` here) in
 * different bounded contexts with different databases. `apps/api/src/pbx` importing from
 * `apps/api/src/cdr` would make the telephony area depend on the reporting area for a sixty-line
 * encoder, and the direction it would establish is the one the two contexts exist to prevent. The
 * duplication is the cheaper of the two costs, and it is stated here so it is a decision rather
 * than an oversight.
 *
 * ## Why the pair, not just `occurred_at`
 *
 * `occurred_at` is not unique: `PUT …/reorder` writes one ledger row per moved child inside a
 * single transaction, and a bulk provisioning script produces dozens in the same millisecond.
 * Paging on the timestamp alone either repeats those rows or drops them, depending on which
 * comparison you pick. `id` is UUID v7 and therefore itself time-ordered, so `(occurred_at, id)`
 * is a total order that never ties and never contradicts the visible sort.
 *
 * ## Why it is opaque
 *
 * base64url of `<iso>|<uuid>`, trivially reversible and not pretending otherwise — it is not a
 * signed token and carries nothing secret (both values are columns of the row the client just
 * rendered). It is opaque so clients treat it as a handle and the sort key can change without
 * breaking them. A tampered cursor can only ever move a caller within their OWN tenant's rows:
 * the organization predicate comes from the session and the RLS policy, never from here.
 */

export interface AuditLogCursor {
	/** The `occurred_at` of the last row of the previous page. */
	readonly occurredAt: Date;
	/** That row's id, breaking ties within the same instant. */
	readonly id: string;
}

const CURSOR_SEPARATOR = "|";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Raised for anything that is not one of our cursors. The service turns it into a 400. */
export class AuditLogCursorError extends Error {
	readonly _tag = "AuditLogCursorError" as const;

	constructor(message: string) {
		super(message);
		this.name = "AuditLogCursorError";
	}
}

export function encodeAuditLogCursor(cursor: AuditLogCursor): string {
	return Buffer.from(
		`${cursor.occurredAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`,
		"utf8",
	).toString("base64url");
}

export function decodeAuditLogCursor(value: string): AuditLogCursor {
	if (value.length === 0 || value.length > 256) {
		throw new AuditLogCursorError("empty or oversized");
	}
	let decoded: string;
	try {
		decoded = Buffer.from(value, "base64url").toString("utf8");
	} catch {
		throw new AuditLogCursorError("not base64url");
	}
	const separator = decoded.indexOf(CURSOR_SEPARATOR);
	if (separator === -1) {
		throw new AuditLogCursorError("malformed");
	}
	const occurredAt = new Date(decoded.slice(0, separator));
	const id = decoded.slice(separator + 1);
	if (Number.isNaN(occurredAt.getTime())) {
		throw new AuditLogCursorError("unreadable timestamp");
	}
	if (!UUID_PATTERN.test(id)) {
		throw new AuditLogCursorError("unreadable id");
	}
	return { occurredAt, id };
}

/**
 * The cursor for the page that follows `rows`, or `null` when there is no next page.
 *
 * "No next page" is decided by having asked for one more row than the page holds and not getting
 * it — never by `rows.length < limit` alone, which is indistinguishable from a full last page and
 * would leave a "Next" button that returns nothing.
 */
export function nextAuditLogCursor<T extends { readonly id: string; readonly occurredAt: Date }>(
	rows: readonly T[],
	limit: number,
	fetched: number,
): string | null {
	if (fetched <= limit || rows.length === 0) {
		return null;
	}
	const last = rows[rows.length - 1];
	return last === undefined
		? null
		: encodeAuditLogCursor({ occurredAt: last.occurredAt, id: last.id });
}
