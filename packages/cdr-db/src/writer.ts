import { sql, type SQL } from "drizzle-orm";
import { CDR_WRITER_SETTING_NAME } from "./cdr-context";
import type { TranscriptionStatus } from "./schema/enums";

/**
 * The CDR writer path.
 *
 * ## Why this is not a second RLS role — the decision, in full
 *
 * `call_legs` and `call_events` are append-only ledgers for the tenant role: it holds SELECT and
 * INSERT and nothing else, and `@optimiq-voice/db`'s preflight asserts EXACTLY two policies on an
 * append-only table (`<table>_tenant_select` + `<table>_tenant_insert`, each granted to exactly
 * `cdr_tenant_tls`). Adding a narrow UPDATE policy for a second role — the obvious way to let
 * transcription and media-quality results land late — would push the policy count to three and
 * fail boot preflight for every service that reads this database.
 *
 * Rejected alternatives:
 * - **Third policy for a `cdr_writer_tls` role.** Breaks the preflight invariant above, and the
 *   invariant is the thing that makes "append-only" auditable in one catalogue query.
 * - **Relax `call_legs` to `no-delete` (one FOR ALL policy, UPDATE allowed).** Gives the tenant
 *   reporting path the ability to rewrite billed durations and hangup causes. Not acceptable.
 * - **A separate `call_leg_enrichment` table joined at read time.** Correct but expensive: it
 *   doubles the partitioned write volume and puts a join on the hottest reporting query for
 *   three columns that are set at most once per leg.
 *
 * ## What we do instead
 *
 * Enrichment runs as the schema OWNER. `FORCE ROW LEVEL SECURITY` is deliberately not set on the
 * CDR tables (the preflight plan asserts it in both directions), so the owner is not subject to
 * the tenant policies and needs no policy of its own. The safety that RLS would have provided is
 * replaced by making the unsafe statement unwritable: `buildCallLegEnrichmentQuery` is the only
 * exported way to update a leg, and it always emits `organization_id = $org` plus the partition
 * key, so an enrichment can neither cross a tenant boundary nor scan every partition.
 *
 * `withCdrWriterScope` additionally publishes the organization id as a transaction-local setting
 * so audit triggers and `pg_stat_activity` can attribute the write. It is a marker, not a
 * boundary — the predicate in the statement is the boundary.
 */

export interface CallLegEnrichment {
	/** S3 object key, set once the recording is finalized and uploaded. */
	readonly recordingKey?: string | null;
	readonly transcriptionStatus?: TranscriptionStatus;
	/** Media quality reported asynchronously by the media plane. */
	readonly mos?: number | null;
	readonly jitterMs?: number | null;
	readonly packetLossPct?: number | null;
}

export interface CallLegEnrichmentTarget {
	readonly organizationId: string;
	readonly callLegId: string;
	/**
	 * The leg's `started_at`. Required, not optional: it is the partition key, and without it
	 * PostgreSQL has to touch every partition to find one row.
	 */
	readonly startedAt: Date;
}

/** Raised before any SQL is built when an enrichment would be a no-op or is unscoped. */
export class CdrWriterScopeError extends Error {
	readonly _tag = "CdrWriterScopeError" as const;

	constructor(message: string) {
		super(message);
		this.name = "CdrWriterScopeError";
	}
}

/** Columns the writer may set after the leg row exists. Nothing else is ever updatable. */
const ENRICHABLE_COLUMNS = {
	recordingKey: "recording_key",
	transcriptionStatus: "transcription_status",
	mos: "mos",
	jitterMs: "jitter_ms",
	packetLossPct: "packet_loss_pct",
} as const satisfies Record<keyof CallLegEnrichment, string>;

export const ENRICHABLE_CALL_LEG_COLUMNS = Object.values(ENRICHABLE_COLUMNS);

/**
 * `update call_legs set <enrichable columns> where organization_id = ... and id = ... and
 * started_at = ...`.
 *
 * Both the tenant predicate and the partition key are unconditional; there is no option to omit
 * either. Returns the updated id so the caller can detect a miss (wrong org, wrong month, or a
 * leg whose partition was already dropped by retention).
 */
export function buildCallLegEnrichmentQuery(
	target: CallLegEnrichmentTarget,
	enrichment: CallLegEnrichment,
): SQL {
	if (target.organizationId.trim().length === 0) {
		throw new CdrWriterScopeError("CDR enrichment requires a non-empty organizationId.");
	}
	const assignments = (Object.keys(ENRICHABLE_COLUMNS) as (keyof CallLegEnrichment)[])
		.filter((key) => enrichment[key] !== undefined)
		.map((key) => sql`${sql.identifier(ENRICHABLE_COLUMNS[key])} = ${enrichment[key] ?? null}`);
	if (assignments.length === 0) {
		throw new CdrWriterScopeError(
			`CDR enrichment must set at least one of ${ENRICHABLE_CALL_LEG_COLUMNS.join(", ")}.`,
		);
	}
	return sql`
		update "call_legs"
		set ${sql.join(assignments, sql`, `)}
		where "organization_id" = ${target.organizationId}::uuid
			and "id" = ${target.callLegId}::uuid
			and "started_at" = ${target.startedAt.toISOString()}::timestamptz
		returning "id"
	`;
}

export interface CdrWriterTransactionHandle {
	readonly execute: (query: SQL) => PromiseLike<unknown>;
}

export interface CdrWriterDatabase<Tx extends CdrWriterTransactionHandle> {
	readonly transaction: <T>(work: (transaction: Tx) => Promise<T>) => Promise<T>;
}

/**
 * Runs owner-principal CDR writes in a transaction tagged with the organization id.
 *
 * Use for: the engine's leg/event inserts when it batches them, and for every enrichment update.
 * Do NOT use for anything a tenant request can reach — those go through
 * `CdrDatabaseClient.withTenantScope`, which is RLS-bound.
 */
export async function withCdrWriterScope<Tx extends CdrWriterTransactionHandle, T>(
	database: CdrWriterDatabase<Tx>,
	organizationId: string,
	work: (transaction: Tx) => Promise<T>,
): Promise<T> {
	const scopedOrganizationId = organizationId.trim();
	if (scopedOrganizationId.length === 0) {
		throw new CdrWriterScopeError("CDR writer scope requires a non-empty organizationId.");
	}
	return await database.transaction(async (transaction) => {
		await transaction.execute(
			sql`select set_config(${CDR_WRITER_SETTING_NAME}, ${scopedOrganizationId}, true)`,
		);
		return await work(transaction);
	});
}
