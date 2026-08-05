import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * Star-code catalogue and caller screening.
 *
 * A feature code is `code` → `action` + `params`. The action list is closed (a const tuple) so
 * the engine can exhaustively switch on it; anything a tenant wants to parameterise goes in
 * `params`, e.g. `{ "lotId": "…" }` for `call-park`.
 */

export const FEATURE_CODE_ACTIONS = [
	"voicemail-check",
	"voicemail-direct",
	"voicemail-record-greeting",
	"call-park",
	"call-pickup",
	"group-pickup",
	"call-forward-all",
	"call-forward-busy",
	"call-forward-no-answer",
	"do-not-disturb",
	"follow-me",
	"intercom",
	"paging",
	"record-toggle",
	"redial",
	"echo-test",
	"queue-toggle",
	"agent-status",
	"eavesdrop",
	"transfer",
] as const;
export type FeatureCodeAction = (typeof FEATURE_CODE_ACTIONS)[number];

export type FeatureCodeParams = Readonly<Record<string, string | number | boolean>>;

export const featureCode = pgTable.withRLS(
	"feature_code",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Dialed string including the leading star, e.g. `*97`. */
		code: text("code").notNull(),
		action: text("action").$type<FeatureCodeAction>().notNull(),
		params: jsonb("params").$type<FeatureCodeParams>(),
		label: text("label"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("feature_code_organization_code_key").on(table.organizationId, table.code),
		index("feature_code_organization_action_idx").on(table.organizationId, table.action),
		tenantIsolationPolicy("feature_code"),
	],
);

export const CALL_BLOCK_DIRECTIONS = ["inbound", "outbound", "both"] as const;
export type CallBlockDirection = (typeof CALL_BLOCK_DIRECTIONS)[number];

export const CALL_BLOCK_ACTIONS = ["block", "allow", "reject", "voicemail"] as const;
export type CallBlockAction = (typeof CALL_BLOCK_ACTIONS)[number];

export const CALL_BLOCK_MATCH_KINDS = ["exact", "prefix", "regex"] as const;
export type CallBlockMatchKind = (typeof CALL_BLOCK_MATCH_KINDS)[number];

/**
 * Caller allow/deny list. `allow` rules win over `block` rules at the same specificity, which is
 * how an allowlist entry escapes a broad prefix block.
 */
export const callBlockRule = pgTable.withRLS(
	"call_block_rule",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		pattern: text("pattern").notNull(),
		matchKind: text("match_kind").$type<CallBlockMatchKind>().notNull().default("exact"),
		direction: text("direction").$type<CallBlockDirection>().notNull().default("inbound"),
		action: text("action").$type<CallBlockAction>().notNull().default("block"),
		label: text("label"),
		hitCount: integer("hit_count").notNull().default(0),
		lastHitAt: utcTimestamp("last_hit_at"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("call_block_rule_organization_direction_pattern_key").on(
			table.organizationId,
			table.direction,
			table.pattern,
		),
		index("call_block_rule_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("call_block_rule"),
	],
);
