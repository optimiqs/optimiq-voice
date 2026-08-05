import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { buildTenantSessionStatements } from "@optimiq-voice/db";
import { createEntityId } from "@optimiq-voice/identifiers";
import { cdrTenantContext } from "../cdr-context";

/**
 * Shared fixture for the `*.integration.spec.ts` files.
 *
 * Gated on `RUN_DB_INTEGRATION_TESTS=true` plus a connection string, and run with
 * `--max-concurrency 1` because the specs create and drop real partitions. Excluded from the
 * published build (see `tsconfig.build.json`).
 */
export const CDR_INTEGRATION_TESTS_ENABLED =
	process.env.RUN_DB_INTEGRATION_TESTS === "true" &&
	Boolean(process.env.CDR_DATABASE_URL ?? process.env.CDR_DATABASE_MIGRATION_URL);

export function cdrIntegrationDatabaseUrl(): string {
	const url = process.env.CDR_DATABASE_URL ?? process.env.CDR_DATABASE_MIGRATION_URL;
	if (!url) {
		throw new Error("CDR_DATABASE_URL must be set for CDR integration specs.");
	}
	return url;
}

export interface CdrIntegrationDatabase {
	readonly db: ReturnType<typeof drizzle>;
	readonly raw: postgres.Sql;
	/** Runs `work` as the RLS-bound tenant role, scoped to `organizationId`. */
	readonly asTenant: <T>(
		organizationId: string,
		work: (execute: (query: SQL) => Promise<unknown>) => Promise<T>,
	) => Promise<T>;
	/** Runs `work` as the tenant role WITHOUT publishing an organization id. */
	readonly asUnscopedTenant: <T>(
		work: (execute: (query: SQL) => Promise<unknown>) => Promise<T>,
	) => Promise<T>;
	readonly close: () => Promise<void>;
}

export function createCdrIntegrationDatabase(): CdrIntegrationDatabase {
	const raw = postgres(cdrIntegrationDatabaseUrl(), { max: 2 });
	const db = drizzle({ client: raw });
	const statements = buildTenantSessionStatements(cdrTenantContext);

	return {
		db,
		raw,
		asTenant: async (organizationId, work) =>
			await db.transaction(async (transaction) => {
				await transaction.execute(statements.setRole);
				await transaction.execute(statements.setOrganization(organizationId));
				return await work(async (query) => await transaction.execute(query));
			}),
		asUnscopedTenant: async (work) =>
			await db.transaction(async (transaction) => {
				await transaction.execute(statements.setRole);
				return await work(async (query) => await transaction.execute(query));
			}),
		close: async () => {
			await raw.end({ timeout: 5 });
		},
	};
}

export interface CallLegFixture {
	readonly id: string;
	readonly organizationId: string;
	readonly callId: string;
	readonly startedAt: Date;
}

/** Inserts a minimal valid A-leg as the schema owner. */
export function insertCallLegQuery(
	fixture: CallLegFixture,
	overrides: {
		readonly recordingKey?: string | null;
		readonly disposition?: string;
		readonly hangupCause?: string;
	} = {},
): SQL {
	return sql`
		insert into "call_legs" (
			"id", "organization_id", "call_id", "leg", "direction",
			"from_number", "to_number", "destination_type", "disposition",
			"hangup_cause", "hangup_cause_code", "started_at", "recording_key"
		) values (
			${fixture.id}::uuid, ${fixture.organizationId}::uuid, ${fixture.callId}::uuid, 'a', 'inbound',
			'+15551230000', '+15551230001', 'extension', ${overrides.disposition ?? "answered"},
			${overrides.hangupCause ?? "NORMAL_CLEARING"}, 16, ${fixture.startedAt.toISOString()}::timestamptz,
			${overrides.recordingKey ?? null}
		)
	`;
}

export function makeCallLegFixture(organizationId: string, startedAt: Date): CallLegFixture {
	return { id: createEntityId(), organizationId, callId: createEntityId(), startedAt };
}

/**
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose own message is only the failed
 * SQL, so a spec asserting "permission denied" has to walk the cause chain to find it.
 */
export function describeDatabaseError(error: unknown): string {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
		messages.push(current.message);
		current = (current as { readonly cause?: unknown }).cause;
	}
	return messages.join(" | ");
}

/** Runs `work`, requires it to be rejected by PostgreSQL, and returns the full cause chain. */
export async function captureDatabaseError(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
	} catch (error) {
		return describeDatabaseError(error);
	}
	throw new Error("Expected PostgreSQL to reject the statement, but it succeeded.");
}

/** Rows a spec created, removed as the owner so RLS cannot hide leftovers from cleanup. */
export function deleteOrganizationRowsQuery(organizationIds: readonly string[]): SQL {
	const ids = sql.join(
		organizationIds.map((id) => sql`${id}::uuid`),
		sql`, `,
	);
	return sql`
		with cleaned_events as (delete from "call_events" where "organization_id" in (${ids}))
		, cleaned_recordings as (delete from "recordings" where "organization_id" in (${ids}))
		delete from "call_legs" where "organization_id" in (${ids})
	`;
}
