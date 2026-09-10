import { z } from "zod/v4";
import {
	CALL_DIRECTIONS,
	CALL_DISPOSITIONS,
	CALL_LEG_SIDES,
	HANGUP_CAUSES,
	RECORDING_KINDS,
} from "@optimiq-voice/cdr-db";
import {
	DEFAULT_AGENT_STATS_GROUPS,
	DEFAULT_WRAP_UP_SECONDS,
	MAX_AGENT_STATS_GROUPS,
	MAX_WRAP_UP_SECONDS,
} from "./agent-stats";
import { DEFAULT_VOLUME_BUCKET, MAX_VOLUME_BUCKETS, VOLUME_BUCKETS } from "./call-volume";
import { DEFAULT_SLA_SECONDS, MAX_SLA_SECONDS } from "./queue-stats";

/**
 * The query contract for the reporting surface.
 *
 * ## The time range is mandatory, with a default rather than a demand
 *
 * Every listing here is bounded by `started_at`, because that column is the partition key: a query
 * without it is a scan of the whole ledger, and the whole point of partitioning was that no request
 * can do that. Rather than making the client send one — which produces exactly one client that
 * forgets, in production, on the largest tenant — the range DEFAULTS to the last 24 hours. Callers
 * who want more say so, up to {@link MAX_RANGE_DAYS}.
 *
 * ## The value domains come from `cdr-db`
 *
 * `direction`, `disposition`, `hangupCause` and `leg` are re-derived from the package that owns the
 * `check` constraints, so a filter can never accept a value the column refuses (which would be a
 * confusing empty result rather than an error) and can never fall behind a value the column gained.
 */

export const DEFAULT_RANGE_HOURS = 24;
/**
 * Twelve weeks and change, in days.
 *
 * Chosen as roughly one quarter — the widest window a person actually reads a call list over —
 * which is three or four monthly partitions. Anything larger is a report, not a list, and belongs
 * on the export path where it can be produced asynchronously.
 */
export const MAX_RANGE_DAYS = 92;
export const DEFAULT_CDR_LIMIT = 25;
export const MAX_CDR_LIMIT = 100;

const isoDateTime = z.iso.datetime({ offset: true }).or(z.iso.datetime());

/** A trimmed free-text term; empty becomes `undefined` so "cleared the box" is not "match ''". */
const searchTerm = z
	.string()
	.max(128)
	.optional()
	.transform((value) => value?.trim())
	.transform((value) => (value === undefined || value.length === 0 ? undefined : value));

/**
 * A dialable identifier used as an EXACT filter (`extension`, `did`).
 *
 * Exact rather than partial on purpose: "show me everything for 2043" must not also return the
 * calls of 12043 and 20430. Partial matching is what `search` is for, and the two being different
 * controls is what makes the difference legible.
 */
const dialFilter = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[+*#0-9A-Za-z._-]+$/u, "must be a dialable string")
	.optional();

/**
 * `GET /cdr/queue-stats` — service level over a window.
 *
 * The window shape is shared with every other reporting query here, so `MAX_RANGE_DAYS` applies
 * unchanged: this is a live aggregate, not a rollup, and a year of a large tenant belongs on the
 * export path. `slaSeconds` is a query parameter rather than a stored setting because it is a
 * QUESTION, not a configuration — a supervisor comparing "how are we at 20 seconds" against "how
 * are we at 60" is doing the normal thing with this endpoint, and a column would make that two
 * writes and a race.
 */
export const queueStatsQuerySchema = z.strictObject({
	from: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
	to: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
	/** One queue, or every queue with traffic in the window. */
	queueId: z.uuid().optional(),
	slaSeconds: z.coerce.number().int().min(1).max(MAX_SLA_SECONDS).default(DEFAULT_SLA_SECONDS),
});

export type QueueStatsQueryDto = z.infer<typeof queueStatsQuerySchema>;

const timeRangeShape = {
	/** Inclusive lower bound on `started_at`. Defaults to 24 hours before `to`. */
	from: isoDateTime.optional(),
	/** Exclusive upper bound on `started_at`. Defaults to now. */
	to: isoDateTime.optional(),
} as const;

/**
 * `GET /cdr/agent-stats` — per-agent handling over a window.
 *
 * Same window contract as every other reporting query here, and the same argument for it. The two
 * parameters that are NOT the window are both questions rather than settings, which is why neither
 * is a stored column: `wrapUpSeconds` is where a supervisor decides how long a gap still counts as
 * after-call work (see `agent-stats.ts` for why that is a proxy at all), and `limit` is the group
 * ceiling rather than a page size — there is no cursor here, deliberately, and the module header
 * argues why.
 */
export const agentStatsQuerySchema = z.strictObject({
	...timeRangeShape,
	/** One agent, or every agent who took a call in the window. A `queue_agent` row id. */
	agentId: z.uuid().optional(),
	/** One queue, or every queue. */
	queueId: z.uuid().optional(),
	wrapUpSeconds: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_WRAP_UP_SECONDS)
		.default(DEFAULT_WRAP_UP_SECONDS),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_AGENT_STATS_GROUPS)
		.default(DEFAULT_AGENT_STATS_GROUPS),
});

export type AgentStatsQueryDto = z.infer<typeof agentStatsQuerySchema>;

/**
 * `GET /cdr/call-volume` — bucketed counts over a window.
 *
 * `bucket` is an enum and not a free-text `date_trunc` grain, which is the difference between a
 * validated parameter and an injection site — `call-volume.ts` binds it rather than interpolating
 * it as well, so both halves have to fail before it matters.
 *
 * `limit` caps the number of BUCKETS. It cannot bite on a window this DTO accepts
 * ({@link MAX_RANGE_DAYS} days of hours is exactly {@link MAX_VOLUME_BUCKETS}); it is here so that
 * the two constants drifting apart shows up as a `truncated` flag rather than as a chart that
 * silently stops.
 */
export const callVolumeQuerySchema = z.strictObject({
	...timeRangeShape,
	bucket: z.enum(VOLUME_BUCKETS).default(DEFAULT_VOLUME_BUCKET),
	limit: z.coerce.number().int().min(1).max(MAX_VOLUME_BUCKETS).default(MAX_VOLUME_BUCKETS),
});

export type CallVolumeQueryDto = z.infer<typeof callVolumeQuerySchema>;

export const cdrListQuerySchema = z.object({
	...timeRangeShape,

	direction: z.enum(CALL_DIRECTIONS).optional(),
	disposition: z.enum(CALL_DISPOSITIONS).optional(),
	hangupCause: z.enum(HANGUP_CAUSES).optional(),
	leg: z.enum(CALL_LEG_SIDES).optional(),

	/** Matches an internal number on either side of the leg. */
	extension: dialFilter,
	/** Matches a DID on either side of the leg. Same mechanism as `extension`, different intent. */
	did: dialFilter,
	/** Narrow to legs that produced media. `true` only; there is no "recorded = false" question. */
	recorded: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).optional(),

	/** Partial, case-insensitive, over caller number, caller name and callee number. */
	search: searchTerm,

	limit: z.coerce.number().int().min(1).max(MAX_CDR_LIMIT).default(DEFAULT_CDR_LIMIT),
	/** Opaque keyset handle from the previous page's `nextCursor`. */
	cursor: z.string().max(256).optional(),
});

export type CdrListQuery = z.infer<typeof cdrListQuerySchema>;

/**
 * Reading ONE leg.
 *
 * `startedAt` is optional but is the difference between an index seek in one partition and a scan
 * of every partition the fallback range covers, so the UI always sends it (it has the value — it
 * came from the row it is expanding). When it is absent the lookup is bounded by the same
 * `from`/`to` defaults as the listing, which is what keeps a hand-typed id from becoming a full
 * ledger scan.
 */
export const cdrLegQuerySchema = z.object({
	...timeRangeShape,
	startedAt: isoDateTime.optional(),
});

export type CdrLegQuery = z.infer<typeof cdrLegQuerySchema>;

/** Every leg sharing one `call_id`. Bounded the same way, for the same reason. */
export const cdrCallQuerySchema = z.object(timeRangeShape);

export type CdrCallQuery = z.infer<typeof cdrCallQuerySchema>;

/**
 * The recordings listing.
 *
 * Bounded by `created_at` rather than `started_at`: `recordings` is NOT partitioned (its volume is
 * bounded by recorded calls, which is one to two orders of magnitude below all calls), so the range
 * here is a filter rather than a partition-pruning necessity. It is still defaulted and still
 * capped, because a list endpoint that can return everything is a list endpoint that eventually
 * does.
 */
export const recordingListQuerySchema = z.object({
	...timeRangeShape,
	kind: z.enum(RECORDING_KINDS).optional(),
	callId: z.uuid().optional(),
	legId: z.uuid().optional(),
	/** Include rows whose media has been purged. Off by default: a tombstone cannot be played. */
	includeDeleted: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).default(false),
	search: searchTerm,
	limit: z.coerce.number().int().min(1).max(MAX_CDR_LIMIT).default(DEFAULT_CDR_LIMIT),
	cursor: z.string().max(256).optional(),
});

export type RecordingListQuery = z.infer<typeof recordingListQuerySchema>;

export interface ResolvedTimeRange {
	readonly from: Date;
	readonly to: Date;
}

/**
 * Turns the optional `from`/`to` pair into a concrete window.
 *
 * Returns the range rather than throwing on a too-wide one: the caller decides which exception the
 * area raises, and keeping this function total is what lets it be tested without a Nest context.
 * An inverted range (`from` after `to`) is normalized by swapping rather than rejected — it is
 * always a client that built the two controls in the wrong order, and the intent is unambiguous.
 */
export function resolveTimeRange(
	query: { readonly from?: string; readonly to?: string },
	now: Date = new Date(),
): ResolvedTimeRange {
	const to = query.to === undefined ? now : new Date(query.to);
	const from =
		query.from === undefined
			? new Date(to.getTime() - DEFAULT_RANGE_HOURS * 60 * 60 * 1000)
			: new Date(query.from);
	return from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from };
}

/** Whole days the range spans, rounded up — what {@link MAX_RANGE_DAYS} is compared against. */
export function rangeDays(range: ResolvedTimeRange): number {
	return Math.ceil((range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000));
}
