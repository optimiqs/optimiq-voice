import {
	boolean,
	cidr,
	index,
	inet,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { appendOnlyTenantPolicies, tenantIsolationPolicy } from "../tenant";

/**
 * Network ACLs and the change ledger.
 */

export const SIP_ACL_ACTIONS = ["allow", "deny"] as const;
export type SipAclAction = (typeof SIP_ACL_ACTIONS)[number];

/** Which surface an ACL entry guards. Keeping these separate is the anti-toll-fraud boundary. */
export const SIP_ACL_SCOPES = ["registration", "trunk", "provisioning", "api"] as const;
export type SipAclScope = (typeof SIP_ACL_SCOPES)[number];

export const sipAclEntry = pgTable.withRLS(
	"sip_acl_entry",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name"),
		/** Native `cidr` so PostgreSQL validates and normalizes the network. */
		network: cidr("network").notNull(),
		action: text("action").$type<SipAclAction>().notNull().default("allow"),
		scope: text("scope").$type<SipAclScope>().notNull().default("registration"),
		/** Lower first. Ties are broken by the most specific prefix. */
		priority: integer("priority").notNull().default(100),
		description: text("description"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("sip_acl_entry_organization_scope_network_key").on(
			table.organizationId,
			table.scope,
			table.network,
		),
		index("sip_acl_entry_organization_enabled_priority_idx").on(
			table.organizationId,
			table.enabled,
			table.priority,
		),
		tenantIsolationPolicy("sip_acl_entry"),
	],
);

export const AUDIT_ACTOR_TYPES = ["user", "api-key", "service", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Append-only change ledger.
 *
 * The tenant role holds only `SELECT, INSERT` and carries two policies
 * (`audit_log_tenant_select` / `audit_log_tenant_insert`) instead of one `FOR ALL` policy, so
 * neither a bug nor a compromised runtime principal can rewrite history. That is also why the
 * table has `created_at` but no `updated_at`: an updatable timestamp on an immutable ledger is a
 * contradiction, and the tenant role has no UPDATE privilege to maintain it.
 */
export const auditLog = pgTable.withRLS(
	"audit_log",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		actorType: text("actor_type").$type<AuditActorType>().notNull().default("user"),
		/** `user.id` in the auth database. Plain UUID: no cross-database foreign keys. */
		actorUserId: uuidEntityId("actor_user_id"),
		/** `api_key.id` when `actorType = "api-key"`; the service name otherwise. */
		actorRef: text("actor_ref"),
		/** Dotted permission-style verb, e.g. `extension.update`. */
		action: text("action").notNull(),
		/** Physical table name of the changed row, e.g. `extension`. */
		resourceType: text("resource_type").notNull(),
		resourceRef: uuidEntityId("resource_ref"),
		before: jsonb("before"),
		after: jsonb("after"),
		ipAddress: inet("ip_address"),
		userAgent: text("user_agent"),
		/** Correlation id from the request pipeline, so a ledger row joins to a log line. */
		requestId: uuidEntityId("request_id"),
		occurredAt: utcTimestamp("occurred_at").notNull().defaultNow(),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		/**
		 * The reading index, and the reason `id` is on the end of it.
		 *
		 * `/api/v1/audit-log` pages the ledger with a keyset over `(occurred_at, id)` — see
		 * `apps/api/src/pbx/audit-log/audit-log.cursor.ts` for why a ledger cannot use `offset` —
		 * and a row comparison `(occurred_at, id) < (…, …)` is only an index SEEK when the index
		 * carries both columns in that order. With `(organization_id, occurred_at)` alone the
		 * comparison degrades into a filter over every row in the requested window, which is the
		 * cost the cursor exists to avoid. `id` is UUID v7 and therefore already time-ordered, so
		 * the third column also never contradicts the visible sort.
		 *
		 * Extended in place rather than added alongside: this table takes a write on every mutation
		 * in the tenant, so a fourth index whose first two columns duplicate an existing one would
		 * be paid for on every change and read by nothing.
		 */
		index("audit_log_organization_occurred_idx").on(
			table.organizationId,
			table.occurredAt,
			table.id,
		),
		index("audit_log_organization_resource_idx").on(
			table.organizationId,
			table.resourceType,
			table.resourceRef,
		),
		index("audit_log_organization_actor_idx").on(table.organizationId, table.actorUserId),
		index("audit_log_organization_action_idx").on(table.organizationId, table.action),
		...appendOnlyTenantPolicies("audit_log"),
	],
);
