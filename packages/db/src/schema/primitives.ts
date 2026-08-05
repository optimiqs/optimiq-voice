import {
	type PgTimestampBuilder,
	type PgUUIDBuilder,
	type SetHasDefault,
	type SetHasRuntimeDefault,
	type SetIsPrimaryKey,
	type SetNotNull,
	timestamp,
	uuid as pgUuid,
} from "drizzle-orm/pg-core";
import { createEntityId } from "@optimiq-voice/identifiers";

/** Native PostgreSQL UUID column for durable internal entity references. */
export const uuidEntityId = (name = "id"): PgUUIDBuilder => pgUuid(name);

/** Native UUID entity column with an application-side UUID v7 default. */
export const uuidV7EntityId = (name = "id"): SetHasRuntimeDefault<PgUUIDBuilder> =>
	uuidEntityId(name).$defaultFn(createEntityId);

/**
 * UUID v7 is sortable by creation time and is the default for every new durable entity.
 * The default is applied in the application so identifiers exist before the insert round trip.
 */
export const uuidV7PrimaryKey = (
	name = "id",
): SetIsPrimaryKey<SetHasRuntimeDefault<PgUUIDBuilder>> => uuidV7EntityId(name).primaryKey();

/**
 * Native UUID tenant key used by organization-scoped tables. Every row-level-security policy
 * compares this column against the tenant transaction's `organization_id` setting.
 */
export const tenantOrganizationIdColumn = (name = "organization_id"): SetNotNull<PgUUIDBuilder> =>
	uuidEntityId(name).notNull();

/** New timestamps are timezone-aware Date values; PostgreSQL normalizes them to UTC. */
export const utcTimestamp = (name: string): PgTimestampBuilder =>
	timestamp(name, { mode: "date", withTimezone: true });

/** Standard `created_at` / `updated_at` pair; `updated_at` is refreshed on every Drizzle update. */
export const auditTimestampColumns = (): {
	createdAt: SetHasDefault<SetNotNull<PgTimestampBuilder>>;
	updatedAt: SetHasDefault<SetHasDefault<SetNotNull<PgTimestampBuilder>>>;
} => ({
	createdAt: utcTimestamp("created_at").notNull().defaultNow(),
	updatedAt: utcTimestamp("updated_at")
		.notNull()
		.defaultNow()
		.$onUpdateFn(() => new Date()),
});
