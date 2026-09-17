import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * One counter, shared by every replica, for anything this platform meters per tenant per window.
 *
 * # The problem it exists to remove
 *
 * The obvious rate limiter is a `Map` in the process, and this codebase has one:
 * `originate-rate-limit.ts` is a per-process heap and says so in its own header — three replicas
 * allow three times the rate. For a burst limiter whose job is to stop one runaway loop that is a
 * defensible trade. For a SPEND cap it is not, because the traffic being capped is spread across
 * every replica by the same load balancer that spreads everyone else's, so the effective ceiling is
 * the configured one multiplied by a number that changes when somebody scales the deployment. A cap
 * nobody can state is a cap nobody budgeted.
 *
 * # Why a table and not the KV bucket
 *
 * NATS KV with a TTL is the shape that first suggests itself, and it is genuinely better at expiry.
 * It is worse at the one operation this table exists for: an increment on a KV value is a
 * read-revision / compare-and-set / retry loop, and the retry rate rises with the contention, which
 * rises with exactly the traffic the counter is trying to limit. A limiter whose cost grows with the
 * attack is a limiter that gives out during one.
 *
 * `insert … on conflict (…) do update set count = shared_rate_window.count + excluded.count
 * returning count` is a single statement, atomic without a transaction of its own, and under
 * contention it QUEUES on the row lock rather than spinning. It also returns the post-increment
 * total, so the caller learns whether it crossed the line in the same round trip that recorded that
 * it did — there is no read-then-write window for two replicas to both pass through.
 *
 * # Fixed windows, not a sliding log
 *
 * `window_start` is the caller's instant floored to `window_ms`, so the row's key is a pure function
 * of the clock and no lookup is needed to find it. The cost is the usual fixed-window artefact: a
 * caller can spend a whole window's budget at the end of one and again at the start of the next.
 * Callers that care read the previous window too and weight it (see `SharedRateWindowService`); the
 * exact alternative is a row per EVENT and an aggregate over a time predicate, which is a scan of
 * the busiest table on the platform on every call.
 *
 * # `expires_at`, and who deletes
 *
 * Every row carries the instant after which it can tell nobody anything, and a sweeper deletes by
 * it. That is a column rather than a partition or a TTL because the rows are tiny, the sweep is a
 * ranged delete on an index, and the alternative — leaving them — is a table that grows forever at
 * the rate of the platform's busiest counter.
 *
 * # `count` can go DOWN
 *
 * The increment is signed, because the same row shape serves a gauge as well as a meter:
 * simultaneous international calls go up on answer and down on hangup. A gauge is clamped at zero by
 * the service rather than by a check constraint, so a hangup whose answer this process never saw
 * (a replica restarted mid-call) leaves the gauge low rather than failing the write and leaving it
 * permanently high — the fail-safe direction for a gauge is the one that eventually recovers.
 */
export const sharedRateWindow = pgTable.withRLS(
	"shared_rate_window",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/**
		 * Which meter this is — `intl-minutes`, `originate`, `intl-concurrent`.
		 *
		 * A free-text token rather than an enum, because the point of a shared table is that a new
		 * caller does not need a migration, and a value nobody recognises simply counts nothing
		 * anybody reads. The scope is what keeps two unrelated meters from colliding on one key.
		 */
		scope: text("scope").notNull(),
		/**
		 * What within the scope — an extension id, a trunk id, or the organization's own id for a
		 * tenant-wide meter.
		 *
		 * `text` and NOT NULL rather than a nullable uuid, for the reason a nullable key would break
		 * the unique index below: PostgreSQL treats NULLs as distinct, so a tenant-wide row keyed on
		 * NULL could be inserted twice and the conflict target would never fire. Every caller passes
		 * a real token; the tenant-wide convention is the organization id.
		 */
		key: text("key").notNull(),
		/** The window's inclusive start: the caller's instant floored to `window_ms`. */
		windowStart: utcTimestamp("window_start").notNull(),
		/** The window's width, carried so a reader can reconstruct the window from the row alone. */
		windowMs: integer("window_ms").notNull(),
		/** The running total. Signed: see the header's note on gauges. */
		count: integer("count").notNull().default(0),
		/** After this, the row is evidence of nothing and the sweeper may delete it. */
		expiresAt: utcTimestamp("expires_at").notNull(),
		...auditTimestampColumns(),
	},
	(table) => [
		/** The upsert's conflict target, and the only lookup any reader performs. */
		uniqueIndex("shared_rate_window_key").on(
			table.organizationId,
			table.scope,
			table.key,
			table.windowStart,
		),
		/**
		 * The sweeper's shape, tenant-first like every other index here.
		 *
		 * The sweep's own predicate is org-agnostic (`expires_at <= now()`) and PostgreSQL will not
		 * skip-scan a leading column for it, so that pass is a scan of this table — the same trade
		 * `device_line`'s hot-desk index records, and acceptable for the same reason: the table holds
		 * one row per (tenant, meter, window), the expired ones are deleted on every tick so it never
		 * accumulates, and a second tenant-blind index would be an index whose only reader runs once a
		 * minute. What this one does serve is the per-tenant read: "what is this organization
		 * currently metering", which is the fraud screen.
		 */
		index("shared_rate_window_organization_expires_idx").on(table.organizationId, table.expiresAt),
		tenantIsolationPolicy("shared_rate_window"),
	],
);
