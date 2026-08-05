import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { mohClass } from "./media-schema";

/**
 * Extensions — the tenant's internal endpoints. FusionPBX carries ~55 columns here; this is the
 * trimmed modern-SaaS set. Things deliberately dropped: `accountcode` (billing lives in the CDR
 * context), `user_context` (contexts are derived by the routing compiler, never authored),
 * `directory_visible`, `distinctive_ring`, per-extension language/voice (an org setting), and
 * `missed_call_action` (an events-hook concern, not a routing one).
 */

/** When the engine records calls that touch this endpoint. */
export const RECORD_POLICIES = ["none", "inbound", "outbound", "all", "on-demand"] as const;
export type RecordPolicy = (typeof RECORD_POLICIES)[number];

/**
 * Outbound-calling privilege class. Outbound routes declare the class they require and an
 * extension may only take a route whose class it holds — the anti-toll-fraud gate.
 */
export const TOLL_CLASSES = ["internal", "local", "national", "international", "premium"] as const;
export type TollClass = (typeof TOLL_CLASSES)[number];

/** How an extension_user link participates in the extension. */
export const EXTENSION_USER_ROLES = ["primary", "shared", "delegate"] as const;
export type ExtensionUserRole = (typeof EXTENSION_USER_ROLES)[number];

/** One hop of a follow-me ladder. Stored as JSON because it is ordered, small and read whole. */
export interface FollowMeTarget {
	/** E.164 number or extension number the engine dials. */
	readonly destination: string;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	/** Require the answering party to press a digit before the leg is bridged. */
	readonly confirm?: boolean;
}

export interface FollowMeConfig {
	readonly enabled: boolean;
	readonly ignoreBusy?: boolean;
	readonly targets: readonly FollowMeTarget[];
}

export const extension = pgTable.withRLS(
	"extension",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		number: text("number").notNull(),
		label: text("label").notNull(),
		/**
		 * Opaque handle into the secret manager holding the SIP password. The password itself is
		 * never stored here; `sipPasswordHa1` is the pre-computed digest the registrar compares
		 * against so authentication needs no secret-manager round trip on every REGISTER.
		 */
		sipSecretRef: text("sip_secret_ref").notNull(),
		sipPasswordHa1: text("sip_password_ha1"),
		/** Caller id presented on internal calls. */
		callerIdName: text("caller_id_name"),
		callerIdNumber: text("caller_id_number"),
		/** Caller id presented to the PSTN; overridden per outbound route when set there. */
		outboundCallerIdName: text("outbound_caller_id_name"),
		outboundCallerIdNumber: text("outbound_caller_id_number"),
		/** Caller id presented on emergency calls; must map to a validated emergency address. */
		emergencyCallerIdName: text("emergency_caller_id_name"),
		emergencyCallerIdNumber: text("emergency_caller_id_number"),
		voicemailEnabled: boolean("voicemail_enabled").notNull().default(true),
		doNotDisturb: boolean("do_not_disturb").notNull().default(false),
		/**
		 * Forwarding is a flag/destination pair per trigger so a user can toggle forwarding off
		 * without losing the number they configured.
		 */
		forwardAllEnabled: boolean("forward_all_enabled").notNull().default(false),
		forwardAllDestination: text("forward_all_destination"),
		forwardBusyEnabled: boolean("forward_busy_enabled").notNull().default(false),
		forwardBusyDestination: text("forward_busy_destination"),
		forwardNoAnswerEnabled: boolean("forward_no_answer_enabled").notNull().default(false),
		forwardNoAnswerDestination: text("forward_no_answer_destination"),
		forwardUnregisteredEnabled: boolean("forward_unregistered_enabled").notNull().default(false),
		forwardUnregisteredDestination: text("forward_unregistered_destination"),
		followMe: jsonb("follow_me").$type<FollowMeConfig>(),
		recordPolicy: text("record_policy").$type<RecordPolicy>().notNull().default("none"),
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "set null",
		}),
		tollClass: text("toll_class").$type<TollClass>().notNull().default("national"),
		callTimeoutSeconds: integer("call_timeout_seconds").notNull().default(30),
		maxRegistrations: integer("max_registrations").notNull().default(3),
		/** Comma-separated codec list overriding the org default, e.g. `OPUS,PCMU,PCMA`. */
		codecOverride: text("codec_override"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("extension_organization_number_key").on(table.organizationId, table.number),
		index("extension_organization_enabled_idx").on(table.organizationId, table.enabled),
		index("extension_organization_label_idx").on(table.organizationId, table.label),
		index("extension_organization_toll_class_idx").on(table.organizationId, table.tollClass),
		index("extension_organization_moh_class_idx").on(table.organizationId, table.mohClassId),
		tenantIsolationPolicy("extension"),
	],
);

/**
 * Links an extension to a better-auth user. `userId` is a plain UUID, not a foreign key: the auth
 * tables live in a different database and cross-database references are forbidden. Integrity is
 * maintained by the API on user deletion (a `user.deleted` event handler).
 */
export const extensionUser = pgTable.withRLS(
	"extension_user",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		extensionId: uuidEntityId("extension_id")
			.notNull()
			.references(() => extension.id, { onDelete: "cascade" }),
		/** `user.id` in the auth database. No FK — see the note above. */
		userId: uuidEntityId("user_id").notNull(),
		role: text("role").$type<ExtensionUserRole>().notNull().default("primary"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("extension_user_organization_extension_user_key").on(
			table.organizationId,
			table.extensionId,
			table.userId,
		),
		index("extension_user_organization_user_idx").on(table.organizationId, table.userId),
		index("extension_user_organization_extension_idx").on(table.organizationId, table.extensionId),
		tenantIsolationPolicy("extension_user"),
	],
);
