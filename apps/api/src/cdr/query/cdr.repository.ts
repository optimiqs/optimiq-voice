import {
	and,
	asc,
	callLegs,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNotNull,
	lte,
	or,
	recordings,
	sql,
} from "@optimiq-voice/cdr-db";
import { decodeCdrCursor } from "./cdr-cursor";
import type { CdrListQuery, RecordingListQuery, ResolvedTimeRange } from "./cdr.dto";
import type { CdrDatabaseTransaction, SQL } from "@optimiq-voice/cdr-db";

/**
 * The reporting queries, as Drizzle over the tenant transaction.
 *
 * ## Every function here takes a transaction, never a client
 *
 * The organization is not a parameter of any query in this file, and that is the point: the caller
 * opens `withTenantScope(organizationId, …)`, which drops into `cdr_tenant_tls` and publishes the
 * id the RLS policies read, and everything below runs inside it. A repository that took an
 * `organizationId` and put it in a `where` clause would be a repository someone can call without
 * one; a repository that can only be handed an already-scoped transaction cannot. The predicates
 * below are therefore about the QUESTION, never about the tenant.
 *
 * ## Every predicate carries the partition key
 *
 * `started_at` bounds are unconditional on `call_legs`. They are what lets PostgreSQL prune to the
 * partitions the range names before it looks at anything else, and they are why there is no
 * "search all history" shape reachable from the HTTP surface at all.
 */

/** Columns the list returns. Deliberately not `select *`: `raw` is a jsonb blob nobody lists. */
const LEG_LIST_COLUMNS = {
	id: callLegs.id,
	callId: callLegs.callId,
	leg: callLegs.leg,
	originatingLegId: callLegs.originatingLegId,
	bridgeLegId: callLegs.bridgeLegId,
	direction: callLegs.direction,
	fromNumber: callLegs.fromNumber,
	fromName: callLegs.fromName,
	toNumber: callLegs.toNumber,
	destinationType: callLegs.destinationType,
	destinationRef: callLegs.destinationRef,
	startedAt: callLegs.startedAt,
	answeredAt: callLegs.answeredAt,
	endedAt: callLegs.endedAt,
	durationMs: callLegs.durationMs,
	billsecMs: callLegs.billsecMs,
	hangupCause: callLegs.hangupCause,
	hangupCauseCode: callLegs.hangupCauseCode,
	hangupSide: callLegs.hangupSide,
	disposition: callLegs.disposition,
	recordingKey: callLegs.recordingKey,
	transcriptionStatus: callLegs.transcriptionStatus,
} as const;

/** The detail view adds the media-quality block and the passthrough jsonb. */
const LEG_DETAIL_COLUMNS = {
	...LEG_LIST_COLUMNS,
	sipCallId: callLegs.sipCallId,
	routingContext: callLegs.routingContext,
	applicationRef: callLegs.applicationRef,
	queueRef: callLegs.queueRef,
	ivrRef: callLegs.ivrRef,
	ringGroupRef: callLegs.ringGroupRef,
	accountCode: callLegs.accountCode,
	pddMs: callLegs.pddMs,
	readCodec: callLegs.readCodec,
	writeCodec: callLegs.writeCodec,
	remoteMediaAddress: callLegs.remoteMediaAddress,
	mos: callLegs.mos,
	jitterMs: callLegs.jitterMs,
	packetLossPct: callLegs.packetLossPct,
	// The outbound PIN that authorised this leg, ordinal and label only — the digits stop at the
	// walker. Denormalised (there is no `pin_set` in this database to join), so the label is the
	// name as it stood when the call was placed and a later rename does not rewrite history.
	authPinOrdinal: callLegs.authPinOrdinal,
	authPinLabel: callLegs.authPinLabel,
	raw: callLegs.raw,
	createdAt: callLegs.createdAt,
} as const;

export type CallLegListRow = {
	[K in keyof typeof LEG_LIST_COLUMNS]: (typeof LEG_LIST_COLUMNS)[K]["_"]["data"];
};
export type CallLegDetailRow = {
	[K in keyof typeof LEG_DETAIL_COLUMNS]: (typeof LEG_DETAIL_COLUMNS)[K]["_"]["data"];
};

/**
 * The keyset comparison for `(started_at, id) DESC`, written as a row comparison.
 *
 * `(a, b) < (x, y)` rather than `a < x or (a = x and b < y)` because the row form is what
 * PostgreSQL can turn into a single index seek on a two-column btree; the expanded boolean form
 * usually degrades into a filter over the whole range. They mean the same thing and cost very
 * differently.
 */
function keysetBefore(startedAt: Date, id: string): SQL {
	return sql`(${callLegs.startedAt}, ${callLegs.id}) < (${startedAt.toISOString()}::timestamptz, ${id}::uuid)`;
}

function legFilters(query: CdrListQuery, range: ResolvedTimeRange): SQL[] {
	const filters: SQL[] = [
		gte(callLegs.startedAt, range.from),
		lte(callLegs.startedAt, range.to),
	] as SQL[];

	if (query.direction !== undefined) {
		filters.push(eq(callLegs.direction, query.direction) as SQL);
	}
	if (query.disposition !== undefined) {
		filters.push(eq(callLegs.disposition, query.disposition) as SQL);
	}
	if (query.hangupCause !== undefined) {
		filters.push(eq(callLegs.hangupCause, query.hangupCause) as SQL);
	}
	if (query.leg !== undefined) {
		filters.push(eq(callLegs.leg, query.leg) as SQL);
	}
	// A number filter is "this party was involved", which on a leg means either end of it. The
	// caller of an outbound leg and the callee of an inbound one are the same extension.
	if (query.extension !== undefined) {
		filters.push(
			or(eq(callLegs.fromNumber, query.extension), eq(callLegs.toNumber, query.extension)) as SQL,
		);
	}
	if (query.did !== undefined) {
		filters.push(or(eq(callLegs.fromNumber, query.did), eq(callLegs.toNumber, query.did)) as SQL);
	}
	if (query.recorded === true) {
		// Matches `call_legs_recording_idx`, a partial index over exactly this predicate.
		filters.push(isNotNull(callLegs.recordingKey) as SQL);
	}
	if (query.search !== undefined) {
		const term = `%${escapeLikeTerm(query.search)}%`;
		filters.push(
			or(
				ilike(callLegs.fromNumber, term),
				ilike(callLegs.toNumber, term),
				ilike(callLegs.fromName, term),
			) as SQL,
		);
	}
	return filters;
}

/**
 * Neutralizes the `LIKE` metacharacters in a user's search term.
 *
 * Without it, a search for `%` matches every row and a search for `_` matches every single
 * character — not an injection (the value is still bound), but a filter that silently means
 * something other than what the user typed.
 */
function escapeLikeTerm(value: string): string {
	return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

export interface LegPage {
	readonly rows: readonly CallLegListRow[];
	/** How many rows came back, INCLUDING the sentinel; the caller uses it to decide "is there more". */
	readonly fetched: number;
}

/**
 * One page of legs, newest first.
 *
 * Fetches `limit + 1` rows and hands both the trimmed page and the raw count back, so "is there a
 * next page" is answered by evidence rather than by `rows.length === limit`, which cannot tell a
 * full last page from a page with more behind it.
 *
 * There is deliberately NO `total`. A `count(*)` over a partitioned ledger is a scan of every
 * partition in the range — the exact cost the cursor exists to avoid — and it would have to be paid
 * on every page. The UI says "1–25, more" rather than "1–25 of 41,882", which is the honest answer
 * a keyset listing can give.
 */
export async function listCallLegs(
	transaction: CdrDatabaseTransaction,
	query: CdrListQuery,
	range: ResolvedTimeRange,
): Promise<LegPage> {
	const filters = legFilters(query, range);
	if (query.cursor !== undefined) {
		const cursor = decodeCdrCursor(query.cursor);
		filters.push(keysetBefore(cursor.startedAt, cursor.id));
	}

	const rows = (await transaction
		.select(LEG_LIST_COLUMNS)
		.from(callLegs)
		.where(and(...filters))
		.orderBy(desc(callLegs.startedAt), desc(callLegs.id))
		.limit(query.limit + 1)) as CallLegListRow[];

	return { rows: rows.slice(0, query.limit), fetched: rows.length };
}

/**
 * One leg by id.
 *
 * `startedAt`, when the caller has it, collapses the search to a single partition via the composite
 * primary key. Without it the bounded range is the only thing keeping this off every partition,
 * which is why the range is applied even here.
 */
export async function getCallLeg(
	transaction: CdrDatabaseTransaction,
	id: string,
	options: { readonly startedAt?: Date; readonly range: ResolvedTimeRange },
): Promise<CallLegDetailRow | undefined> {
	const filters: SQL[] = [eq(callLegs.id, id) as SQL];
	if (options.startedAt === undefined) {
		filters.push(gte(callLegs.startedAt, options.range.from) as SQL);
		filters.push(lte(callLegs.startedAt, options.range.to) as SQL);
	} else {
		filters.push(eq(callLegs.startedAt, options.startedAt) as SQL);
	}

	const rows = (await transaction
		.select(LEG_DETAIL_COLUMNS)
		.from(callLegs)
		.where(and(...filters))
		.limit(1)) as CallLegDetailRow[];
	return rows[0];
}

/**
 * Every leg of one call, oldest first.
 *
 * Ascending rather than descending, unlike the listing: this is a call's TIMELINE, and a timeline
 * that starts at the hangup reads backwards. The A-leg is first by construction, because it is the
 * leg every B-leg was originated from and therefore always started first.
 *
 * Capped at 200: a ring group fanning out to a large team plus its retries is the realistic upper
 * bound, and an unbounded read here would be the one place in the area that can return a whole
 * partition.
 */
export async function listCallLegsForCall(
	transaction: CdrDatabaseTransaction,
	callId: string,
	range: ResolvedTimeRange,
): Promise<readonly CallLegListRow[]> {
	return (await transaction
		.select(LEG_LIST_COLUMNS)
		.from(callLegs)
		.where(
			and(
				eq(callLegs.callId, callId),
				gte(callLegs.startedAt, range.from),
				lte(callLegs.startedAt, range.to),
			),
		)
		.orderBy(asc(callLegs.startedAt), asc(callLegs.id))
		.limit(200)) as CallLegListRow[];
}

// ---------------------------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------------------------

const RECORDING_COLUMNS = {
	id: recordings.id,
	callId: recordings.callId,
	legId: recordings.legId,
	kind: recordings.kind,
	objectKey: recordings.objectKey,
	durationMs: recordings.durationMs,
	sizeBytes: recordings.sizeBytes,
	retentionUntil: recordings.retentionUntil,
	deletedAt: recordings.deletedAt,
	createdAt: recordings.createdAt,
} as const;

export type RecordingListRow = {
	[K in keyof typeof RECORDING_COLUMNS]: (typeof RECORDING_COLUMNS)[K]["_"]["data"];
};

export interface RecordingPage {
	readonly rows: readonly RecordingListRow[];
	readonly fetched: number;
}

function recordingKeysetBefore(createdAt: Date, id: string): SQL {
	return sql`(${recordings.createdAt}, ${recordings.id}) < (${createdAt.toISOString()}::timestamptz, ${id}::uuid)`;
}

export async function listRecordings(
	transaction: CdrDatabaseTransaction,
	query: RecordingListQuery,
	range: ResolvedTimeRange,
): Promise<RecordingPage> {
	const filters: SQL[] = [
		gte(recordings.createdAt, range.from),
		lte(recordings.createdAt, range.to),
	] as SQL[];

	if (query.kind !== undefined) {
		filters.push(eq(recordings.kind, query.kind) as SQL);
	}
	if (query.callId !== undefined) {
		filters.push(eq(recordings.callId, query.callId) as SQL);
	}
	if (query.legId !== undefined) {
		filters.push(eq(recordings.legId, query.legId) as SQL);
	}
	if (!query.includeDeleted) {
		// A tombstone has metadata and no media. Listing it by default would offer a play button
		// that can only ever fail.
		filters.push(sql`${recordings.deletedAt} is null`);
	}
	if (query.search !== undefined) {
		filters.push(ilike(recordings.objectKey, `%${escapeLikeTerm(query.search)}%`) as SQL);
	}
	if (query.cursor !== undefined) {
		const cursor = decodeCdrCursor(query.cursor);
		filters.push(recordingKeysetBefore(cursor.startedAt, cursor.id));
	}

	const rows = (await transaction
		.select(RECORDING_COLUMNS)
		.from(recordings)
		.where(and(...filters))
		.orderBy(desc(recordings.createdAt), desc(recordings.id))
		.limit(query.limit + 1)) as RecordingListRow[];

	return { rows: rows.slice(0, query.limit), fetched: rows.length };
}

/**
 * One recording by id, inside the tenant scope.
 *
 * This is the read the signed-URL path makes before it streams a byte, and the reason it is the
 * TENANT read rather than an owner read: the token proves the request was authorized, and the RLS
 * policy proves the row belongs to the organization the token names. Either alone would be a
 * single point of failure for cross-tenant media access.
 */
export async function getRecording(
	transaction: CdrDatabaseTransaction,
	id: string,
): Promise<RecordingListRow | undefined> {
	const rows = (await transaction
		.select(RECORDING_COLUMNS)
		.from(recordings)
		.where(eq(recordings.id, id))
		.limit(1)) as RecordingListRow[];
	return rows[0];
}

/** Recordings for a set of legs, used to attach media to the legs of one call in one round trip. */
export async function listRecordingsForLegs(
	transaction: CdrDatabaseTransaction,
	legIds: readonly string[],
): Promise<readonly RecordingListRow[]> {
	if (legIds.length === 0) {
		return [];
	}
	return (await transaction
		.select(RECORDING_COLUMNS)
		.from(recordings)
		.where(and(inArray(recordings.legId, [...legIds]), sql`${recordings.deletedAt} is null`))
		.orderBy(asc(recordings.createdAt))
		.limit(200)) as RecordingListRow[];
}

/**
 * A recording row rendered as a cursor key.
 *
 * `nextCursorFrom` keys on `(startedAt, id)` because that is what the LEG listing sorts by; the
 * recordings listing sorts by `(createdAt, id)`. Rather than a second cursor module for a second
 * pair of column names, the recording row is projected into the same shape — the encoding is
 * identical and the two orderings never meet in one query.
 */
export function recordingCursorKey(row: RecordingListRow): {
	readonly id: string;
	readonly startedAt: Date;
} {
	return { id: row.id, startedAt: row.createdAt };
}
