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
 * Network ACLs, the authentication-failure ledger, and the change ledger.
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

/**
 * What refused an attempt. Deliberately the REASON, not the surface — the surface is {@link
 * sipAuthEvent.scope}, and keeping them apart is what lets "every ACL refusal, anywhere" and
 * "everything the provisioning endpoint refused" both be one index scan.
 *
 * The names are chosen to line up with Asterisk's Security Events framework, because that feed is
 * the second writer this table is built for (`apps/asterisk/config/logger.conf` turns it on; the
 * shipper that reads it is the follow-up). `res_pjsip`'s authenticator raises `InvalidAccountID`,
 * `InvalidPassword` and `FailedACL`; those map onto `unknown-account`, `bad-credentials` and
 * `acl-denied` without a translation table anybody has to maintain.
 */
export const SIP_AUTH_EVENT_TYPES = [
	/** The source address was refused by a CIDR rule. Asterisk: `FailedACL`. */
	"acl-denied",
	/** Too many attempts in the window. Asterisk has no equivalent; this is an API-side control. */
	"rate-limited",
	/** No such account, extension or device. Asterisk: `InvalidAccountID`. */
	"unknown-account",
	/** The account exists and the credential was wrong. Asterisk: `InvalidPassword`. */
	"bad-credentials",
	/** A provisioning token that does not match a known device. */
	"token-invalid",
	/** A provisioning token past its expiry. Separate from `token-invalid`: it is a rotation, not an attack. */
	"token-expired",
	/**
	 * The credential was right and the account is switched off.
	 *
	 * Its own type rather than a fold into `unknown-account`, because the two mean opposite things
	 * to a responder: an unknown account is somebody guessing, while a disabled one that still
	 * authenticates is a credential that outlived its authorisation — a decommissioned handset
	 * somebody plugged back in, or a token that was never rotated after an employee left.
	 */
	"disabled-account",
] as const;
export type SipAuthEventType = (typeof SIP_AUTH_EVENT_TYPES)[number];

/**
 * The authentication-failure ledger — the "attack log" row 1.25 of the parity audit says has no
 * counterpart anywhere in the platform.
 *
 * ## Why this is not `audit_log`
 *
 * It was the first thing tried, and it is wrong on three counts.
 *
 * 1. **`audit_log` requires an actor and refuses a row without one** (`audit-log.service.ts`: "an
 *    unattributed row in a ledger whose whole purpose is attribution is worse than a gap somebody
 *    can grep for"). An authentication FAILURE has no actor by definition — the identity is what
 *    could not be established.
 * 2. **It is the CHANGE ledger.** Every mutation in the tenant writes to it, `/api/v1/audit-log`
 *    reads it as change history, and a scanner producing ten thousand rows an hour would bury the
 *    record of who edited an extension inside the noise of who failed to log in.
 * 3. **The shapes do not overlap.** `before`/`after`/`resource_ref` are meaningless here;
 *    `source_ip`, the attempted account name and the transport are meaningless there. Sharing one
 *    table would mean six always-null columns on each of two row kinds.
 *
 * ## The organization is NOT NULL, which bounds what this table can record
 *
 * Stated plainly because it is a real limit rather than an oversight. This is a tenant-scoped table
 * under the same RLS as everything else in the database, so an event can only be recorded once it
 * is attributable — the provisioning token resolved to a device, the account matched an extension,
 * the ACL that refused belonged to a tenant.
 *
 * An attempt against an account that does not exist anywhere has no tenant to file it under, and
 * inventing one would be a cross-tenant leak in the direction nobody checks. Those attempts get a
 * log line and a security-log record on the media server, which is what fail2ban reads and what
 * blocks the address; they are deliberately not rows here. The rule is the same one the change
 * ledger already applies — record what can be attributed, log what cannot — and it is why
 * `unknown-account` is in the type list at all: it fires when the ACCOUNT is unknown but the tenant
 * is not, which is the case an administrator can act on.
 *
 * ## Append-only, like the change ledger
 *
 * `appendOnlyTenantPolicies` and `SELECT, INSERT` in the grants. A security record a compromised
 * runtime principal can edit is not a security record. That is also why there is no `updated_at`.
 *
 * ## Retention
 *
 * There is none yet, and that is a known follow-up rather than a decision: this table grows without
 * bound under attack, which is exactly when it grows fastest. The index below is the keyset shape
 * `audit_log` uses so a sweeper can delete by `(occurred_at, id)` without a full scan when it lands.
 */
export const sipAuthEvent = pgTable.withRLS(
	"sip_auth_event",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		eventType: text("event_type").$type<SipAuthEventType>().notNull(),
		/** Which surface was attacked. The same four the ACL entries are scoped by. */
		scope: text("scope").$type<SipAclScope>().notNull(),
		/** Native `inet` so `<<=` against `sip_acl_entry.network` works without a cast. */
		sourceIp: inet("source_ip"),
		/** The account, extension number or MAC that was attempted. Never a credential. */
		accountRef: text("account_ref"),
		/** `udp` / `tcp` / `tls` / `https`, when the surface knows. */
		transport: text("transport"),
		userAgent: text("user_agent"),
		/** The matched ACL entry, the rate-limit window, the device id — whatever names the refusal. */
		detail: jsonb("detail"),
		/** Correlation id from the request pipeline, so a row joins to a log line. */
		requestId: uuidEntityId("request_id"),
		occurredAt: utcTimestamp("occurred_at").notNull().defaultNow(),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		/** The reading index. `id` last for the same keyset reason `audit_log` records at length. */
		index("sip_auth_event_organization_occurred_idx").on(
			table.organizationId,
			table.occurredAt,
			table.id,
		),
		/**
		 * "Which address is doing this?" — the first question asked of an attack log, and the one a
		 * response depends on, since a firewall rule is written against an address and not against a
		 * reason.
		 */
		index("sip_auth_event_organization_source_idx").on(
			table.organizationId,
			table.sourceIp,
			table.occurredAt,
		),
		index("sip_auth_event_organization_type_idx").on(
			table.organizationId,
			table.eventType,
			table.occurredAt,
		),
		...appendOnlyTenantPolicies("sip_auth_event"),
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
