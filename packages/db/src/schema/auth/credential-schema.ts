import { bigint, boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { utcTimestamp, uuidEntityId, uuidV7PrimaryKey } from "../primitives";
import { user } from "./identity-schema";

/**
 * better-auth credential tables: API keys (@better-auth/api-key), enrolled second factors
 * (two-factor plugin) and the signing key set backing per-call / service JWTs (jwt plugin).
 *
 * `apikey` is deliberately exported under better-auth's model name so the drizzle adapter
 * resolves it; the physical table is `api_key`. `rateLimit` is the same arrangement over
 * `rate_limit`.
 */
export const apikey = pgTable(
	"api_key",
	{
		id: uuidV7PrimaryKey(),
		configId: text("config_id").notNull().default("default"),
		name: text("name"),
		start: text("start"),
		/**
		 * Owner of the key. With `references: "organization"` this is `organization.id`;
		 * it is intentionally not a foreign key so the plugin can be re-pointed at users.
		 */
		referenceId: uuidEntityId("reference_id").notNull(),
		prefix: text("prefix"),
		key: text("key").notNull(),
		refillInterval: integer("refill_interval"),
		refillAmount: integer("refill_amount"),
		lastRefillAt: utcTimestamp("last_refill_at"),
		enabled: boolean("enabled").default(true),
		rateLimitEnabled: boolean("rate_limit_enabled").default(true),
		rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000),
		rateLimitMax: integer("rate_limit_max").default(10),
		requestCount: integer("request_count").default(0),
		remaining: integer("remaining"),
		lastRequest: utcTimestamp("last_request"),
		expiresAt: utcTimestamp("expires_at"),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
		permissions: text("permissions"),
		metadata: text("metadata"),
	},
	(table) => [
		index("api_key_reference_idx").on(table.referenceId),
		index("api_key_key_idx").on(table.key),
		index("api_key_expires_idx").on(table.expiresAt),
	],
);

export const twoFactor = pgTable(
	"two_factor",
	{
		id: uuidV7PrimaryKey(),
		secret: text("secret").notNull(),
		backupCodes: text("backup_codes").notNull(),
		userId: uuidEntityId("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		verified: boolean("verified").default(true),
		failedVerificationCount: integer("failed_verification_count").default(0),
		lockedUntil: utcTimestamp("locked_until"),
	},
	(table) => [index("two_factor_user_idx").on(table.userId)],
);

export const jwks = pgTable(
	"jwks",
	{
		id: uuidV7PrimaryKey(),
		publicKey: text("public_key").notNull(),
		privateKey: text("private_key").notNull(),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		expiresAt: utcTimestamp("expires_at"),
	},
	(table) => [index("jwks_expires_idx").on(table.expiresAt)],
);

/**
 * better-auth's shared rate-limit counters (`rateLimit: { storage: "database" }`).
 *
 * The default store is per-process memory, which with N API replicas gives an attacker N times
 * the limit and resets every window on deploy. This table is the shared one: `key` is the
 * bucket (`<ip>/<path>`), `count` the hits in the window, `last_request` an epoch millisecond
 * stamp — a bigint because that is the number better-auth writes and reads, not a timestamp.
 */
export const rateLimit = pgTable(
	"rate_limit",
	{
		id: uuidV7PrimaryKey(),
		key: text("key").notNull().unique(),
		count: integer("count").notNull().default(0),
		lastRequest: bigint("last_request", { mode: "number" }).notNull(),
	},
	(table) => [index("rate_limit_last_request_idx").on(table.lastRequest)],
);
