import { and, CALL_DESTINATION_TYPES, callLegs, gte, lte, sql } from "@optimiq-voice/cdr-db";
import type { CallDestinationType, CdrDatabaseTransaction, SQL } from "@optimiq-voice/cdr-db";

/**
 * Call volume over time — the trend line behind every "are we busier than last month" question.
 *
 * ## Why a bucketed aggregate and not a client-side roll-up of the listing
 *
 * The listing already returns legs, and a chart could in principle be built by paging it and
 * counting in the browser. That is the version this exists to prevent: a month of a mid-sized
 * tenant is hundreds of thousands of rows, paged twenty-five at a time through a keyset cursor, to
 * produce seven hundred and twenty numbers. `date_trunc` plus `count(*)` does it in one scan of a
 * range the planner has already pruned to a handful of partitions, and it does it without shipping
 * a single caller's number to a client that only wanted a bar chart.
 *
 * ## The two series, and why they are two queries rather than thirteen columns
 *
 * `direction` has three values, so the per-bucket counts are three `count(*) filter (where …)`
 * columns beside the totals — cheap, one pass, and a single row per bucket that a chart can read
 * without a pivot.
 *
 * `destination_type` has thirteen and will gain more (`paging` was appended after the fact, and the
 * enum's own header explains that this is the property the text-plus-check design keeps). Thirteen
 * filtered counts would be a projection that has to be edited every time the domain grows, and a
 * consumer that never hears about the new value. So the destinations are a SECOND grouped query
 * that returns the types actually present, and a type nobody routed to in the window is simply
 * absent — which is the same contract `queue-stats.ts` has for a queue with no traffic.
 *
 * ## Bounded without a cursor, and the bound is not arbitrary
 *
 * `cdr.repository.ts` pages by keyset because a listing over a ledger is unbounded. A bucketed
 * count is not: the bucket count is a function of the WINDOW, and the window is already capped at
 * `MAX_RANGE_DAYS`. Ninety-two days of hourly buckets is {@link MAX_VOLUME_BUCKETS} rows and there
 * is no way to ask for more, so the limit below is a guard against a future where those two
 * constants drift apart rather than a page the caller is expected to turn. It is stated on the
 * envelope all the same, because a silently short chart is a chart people draw conclusions from.
 *
 * ## The ceiling
 *
 * The same one `queue-stats.ts` names: this is a live query, not a rollup. It runs on
 * `call_legs_organization_started_idx` — `(organization_id, started_at desc)`, which is exactly the
 * predicate, the organization arriving from RLS rather than from the query — and needs no index of
 * its own. When a large tenant wants a year, the seam is a materialised hourly rollup keyed
 * `(organization_id, hour)`; these functions' signatures are what such a rollup would keep.
 */

/** Hour for a day or a week; day for a month or a quarter. There is no third useful grain here. */
export const VOLUME_BUCKETS = ["hour", "day"] as const;
export type VolumeBucket = (typeof VOLUME_BUCKETS)[number];
export const DEFAULT_VOLUME_BUCKET: VolumeBucket = "hour";

/**
 * Ninety-two days of hourly buckets — `MAX_RANGE_DAYS * 24`.
 *
 * Derived from the range cap rather than chosen, so an accepted request can never be truncated by
 * it. If someone widens `MAX_RANGE_DAYS` without touching this, the envelope's `truncated` flag is
 * what tells them, instead of a chart that quietly stops in the middle of March.
 */
export const MAX_VOLUME_BUCKETS = 92 * 24;

export interface CallVolumeRow {
	/** The bucket's start instant, ISO, in UTC. `date_trunc` on the partition key. */
	readonly bucket: string;
	readonly total: number;
	readonly inbound: number;
	readonly outbound: number;
	readonly internal: number;
	/**
	 * Legs that reached an answer, by `answered_at is not null`.
	 *
	 * The column and not `disposition = 'answered'`, deliberately: `disposition` is a REPORTING
	 * verdict that a voicemail deposit also satisfies, and "we answered 80% of calls" meaning "80%
	 * of callers reached a mailbox" is the single most misleading number a phone system can print.
	 * `answered_at` is the moment a media path was established, which is what the word means.
	 */
	readonly answered: number;
	/** `total - answered`. Materialised rather than left to the client so the two cannot disagree. */
	readonly unanswered: number;
	/** Mean wall-clock leg length across EVERY leg in the bucket, answered or not. */
	readonly averageDurationMs: number;
	/**
	 * Mean billed length across ANSWERED legs only.
	 *
	 * Answered only, for the reason `queue-stats.ts` averages waits over answered calls only: an
	 * average that included the zeroes of every unanswered leg moves when the answer rate moves, so
	 * a month where more calls went unanswered would report shorter conversations.
	 */
	readonly averageBillsecMs: number;
}

export interface CallVolumeDestinationRow {
	readonly bucket: string;
	readonly destinationType: CallDestinationType;
	readonly total: number;
	readonly answered: number;
}

export interface CallVolumeQuery {
	readonly from: Date;
	readonly to: Date;
	readonly bucket: VolumeBucket;
	readonly limit: number;
}

/** The window bounds, unconditional, so the planner prunes partitions before it reads a page. */
function windowFilters(query: CallVolumeQuery): SQL[] {
	return [gte(callLegs.startedAt, query.from), lte(callLegs.startedAt, query.to)] as SQL[];
}

/**
 * `date_trunc` over the partition key, as a bound parameter rather than an interpolated word.
 *
 * The grain is a validated enum by the time it arrives, so interpolating it would be safe — and
 * that is exactly the argument that stops being true the first time somebody widens the DTO. A
 * parameter is safe whatever the DTO does, and Postgres takes `date_trunc($1, ts)` unremarkably.
 *
 * The consequence is {@link BUCKET_ORDINAL}: repeating the expression in `group by` would emit a
 * SECOND placeholder, and Postgres compares grouping expressions by parse tree — `date_trunc($1,…)`
 * and `date_trunc($4,…)` are not the same node, so the grouping would be rejected as ungrouped
 * columns. The ordinal refers to the one in the projection, which is the only way to say "that
 * expression" once.
 */
function bucketExpression(bucket: VolumeBucket): SQL<Date> {
	return sql<Date>`date_trunc(${bucket}, ${callLegs.startedAt})`;
}

/**
 * `group by 1` / `order by 1` — the projection's FIRST column, which is the bucket.
 *
 * Deliberate and explained in {@link bucketExpression}: a repeated `date_trunc(<param>, …)` is a
 * different parse node from the one in the SELECT and Postgres refuses the grouping outright. This
 * is not a micro-optimisation, it is the only correct spelling given a bound grain.
 */
const BUCKET_ORDINAL = sql`1`;

/**
 * The per-bucket totals. Exported unexecuted so a spec can assert its SQL without a database — the
 * same shape `queue-stats.ts` uses, for the same reason.
 */
export function callVolumeQuery(
	transaction: CdrDatabaseTransaction,
	query: CallVolumeQuery,
): { toSQL(): { sql: string; params: unknown[] } } {
	const bucket = bucketExpression(query.bucket);

	return (
		transaction
			.select({
				bucket,
				total: sql<number>`count(*)`.mapWith(Number),
				inbound: sql<number>`count(*) filter (where ${callLegs.direction} = 'inbound')`.mapWith(
					Number,
				),
				outbound: sql<number>`count(*) filter (where ${callLegs.direction} = 'outbound')`.mapWith(
					Number,
				),
				internal: sql<number>`count(*) filter (where ${callLegs.direction} = 'internal')`.mapWith(
					Number,
				),
				answered: sql<number>`count(*) filter (where ${callLegs.answeredAt} is not null)`.mapWith(
					Number,
				),
				// `coalesce(round(avg(…)), 0)` because `avg` over an empty set is NULL — and the answered
				// filter makes an empty set reachable in any bucket where nobody picked up.
				averageDurationMs: sql<number>`coalesce(round(avg(${callLegs.durationMs})), 0)`.mapWith(
					Number,
				),
				averageBillsecMs:
					sql<number>`coalesce(round(avg(${callLegs.billsecMs}) filter (where ${callLegs.answeredAt} is not null)), 0)`.mapWith(
						Number,
					),
			})
			.from(callLegs)
			.where(and(...windowFilters(query)))
			.groupBy(BUCKET_ORDINAL)
			// Chronological, because it is a trend: a chart that had to sort its own points is a chart
			// that will one day be drawn before it finishes sorting them.
			.orderBy(BUCKET_ORDINAL)
			.limit(query.limit) as never
	);
}

/** The per-bucket, per-destination counts. Same window, same bound, one more grouping column. */
export function callVolumeDestinationQuery(
	transaction: CdrDatabaseTransaction,
	query: CallVolumeQuery,
): { toSQL(): { sql: string; params: unknown[] } } {
	const bucket = bucketExpression(query.bucket);

	return (
		transaction
			.select({
				bucket,
				destinationType: callLegs.destinationType,
				total: sql<number>`count(*)`.mapWith(Number),
				answered: sql<number>`count(*) filter (where ${callLegs.answeredAt} is not null)`.mapWith(
					Number,
				),
			})
			.from(callLegs)
			.where(and(...windowFilters(query)))
			.groupBy(BUCKET_ORDINAL, callLegs.destinationType)
			.orderBy(BUCKET_ORDINAL, callLegs.destinationType)
			// The bucket cap times the domain's size — the widest this grouping can possibly be. Read from
			// the enum rather than written as a number, so a value appended to `CALL_DESTINATION_TYPES`
			// (as `paging` was) cannot silently start truncating the tail of the series.
			.limit(query.limit * CALL_DESTINATION_TYPES.length) as never
	);
}

export interface CallVolumeResult {
	readonly rows: readonly CallVolumeRow[];
	readonly destinations: readonly CallVolumeDestinationRow[];
	/** A bound was reached, so the series is short. See the module header for why this is a guard. */
	readonly truncated: boolean;
}

/**
 * Runs both series and derives the two fields SQL should not.
 *
 * `unanswered` is a subtraction the database would happily do, kept here because it is the one
 * place both series' notion of "answered" is fixed; and the bucket instant is turned into an ISO
 * string here rather than left as a driver `Date`, so the envelope's shape does not depend on which
 * Postgres driver is underneath it.
 *
 * The two queries are sequential rather than concurrent on purpose: they run inside ONE tenant-scope
 * transaction, and a transaction is a single connection — issuing both at once against it is how a
 * "cannot use a connection while another query is in progress" appears under load and nowhere else.
 */
export async function readCallVolume(
	transaction: CdrDatabaseTransaction,
	query: CallVolumeQuery,
): Promise<CallVolumeResult> {
	const totals = (await (callVolumeQuery(transaction, query) as unknown as Promise<
		readonly (Omit<CallVolumeRow, "bucket" | "unanswered"> & { readonly bucket: Date | string })[]
	>)) as readonly (Omit<CallVolumeRow, "bucket" | "unanswered"> & {
		readonly bucket: Date | string;
	})[];

	const destinations = (await (callVolumeDestinationQuery(transaction, query) as unknown as Promise<
		readonly (Omit<CallVolumeDestinationRow, "bucket"> & { readonly bucket: Date | string })[]
	>)) as readonly (Omit<CallVolumeDestinationRow, "bucket"> & {
		readonly bucket: Date | string;
	})[];

	return {
		rows: totals.map((row) => ({
			...row,
			bucket: isoBucket(row.bucket),
			unanswered: row.total - row.answered,
		})),
		destinations: destinations.map((row) => ({ ...row, bucket: isoBucket(row.bucket) })),
		truncated: totals.length >= query.limit,
	};
}

/** `date_trunc` comes back as a timestamp; some drivers hand it over already stringified. */
function isoBucket(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
