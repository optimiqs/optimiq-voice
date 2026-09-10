import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantCompositeForeignKey, tenantIsolationPolicy } from "../tenant";
import { mohClass } from "./media-schema";
import { pinSet } from "./pins-schema";

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

/**
 * Whether this extension's outbound caller id is shown to the far end — CLIP/CLIR.
 *
 * `restricted` is the standing withhold: sipd sends the anonymous `From` of RFC 3323 §4.1.1.3 plus
 * `Privacy: id`, and the real number still travels in `P-Asserted-Identity` so the carrier's own
 * authorisation and any lawful-intercept path keep the identity. It is a presentation decision, not
 * a suppression of the number, which is why it sits beside `outbound_caller_id_number` rather than
 * replacing it. The emergency path ignores it outright: a 911 call presents the ELIN.
 */
export const CALLER_ID_PRESENTATIONS = ["allowed", "restricted"] as const;
export type CallerIdPresentation = (typeof CALLER_ID_PRESENTATIONS)[number];

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
		/** Whether that number is presented to the far end. See {@link CALLER_ID_PRESENTATIONS}. */
		outboundCallerIdPresentation: text("outbound_caller_id_presentation")
			.$type<CallerIdPresentation>()
			.notNull()
			.default("allowed"),
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
		/**
		 * The pickup group this extension belongs to — the set `*8` may answer within.
		 *
		 * Free text, not a foreign key, and deliberately so: a group is a NAME an administrator
		 * gives a set of desks (`sales`, `floor-2`), it has no properties of its own, and a
		 * `pickup_group` table would buy a join and a migration to express exactly the same set
		 * membership. Upstream stores a string here too.
		 *
		 * NULL means "in no group", which is NOT a group called `""`. The routing compiler trims
		 * and drops blanks (`pickupGroupOf` in `packages/routing/src/compile.ts`), so an extension
		 * without a group compiles to an absent `pickupGroup` and the engine falls back to
		 * organization-wide pickup — the behaviour every extension had before groups existed. The
		 * API trims on the way in and normalises a blank or whitespace-only name to NULL, so the
		 * second spelling of "no group" never reaches the column in the first place.
		 *
		 * No index: nothing queries by group. The snapshot loader reads every extension of an
		 * organization whole, and the engine answers `*8` from the compiled artifact's
		 * `extensionsByNumber`, never from this table.
		 */
		pickupGroup: text("pickup_group"),
		/**
		 * Screen EXTERNAL callers before this extension is rung.
		 *
		 * When it is on, a caller from outside the organization is asked to record their name; the
		 * extension hears "call from <recording>" and presses 1 to accept the call or 2 to reject it.
		 * A rejected call takes the same branch a busy one would, so the caller meets voicemail rather
		 * than a dead line — the screen decides who gets through, not whether the caller is served.
		 *
		 * Scoped to external callers only, and that is a deliberate asymmetry rather than an
		 * unfinished feature. An internal colleague already arrives with a name and a number on the
		 * handset's display, so the recording adds nothing a glance does not already give; screening
		 * them would put ten extra seconds on the front of every internal call in the building, which
		 * is how a feature that helps with one nuisance caller a week becomes the thing everybody
		 * asks to have switched off. The engine decides "external" the same way the rest of the call
		 * path does: a leg that did not originate from an extension of this organization.
		 *
		 * Default off, because it lengthens every inbound call it touches — the caller records, the
		 * callee listens, the callee decides — and a tenant that has never opened this page must not
		 * discover the delay by taking a call.
		 */
		callScreening: boolean("call_screening").notNull().default(false),
		/**
		 * The set of codes that may claim this extension on a shared handset — the hot-desk gate.
		 *
		 * A reference to `pin_set` and not a `hot_desk_pin` column of its own, because the digest
		 * format, the attempt budget, the digit timeout, the prompt pair and the "which code was
		 * used" identity are all already modelled there and getting a second PIN store subtly wrong
		 * is exactly the failure `pins-schema.ts` was written to avoid. An extension whose owner
		 * should be able to hot desk gets a set with their code in it; several extensions may share
		 * one set, which is how a team of six that rotates desks is configured with one form.
		 *
		 * NULL is the ordinary state and it FAILS CLOSED: an extension with no hot-desk set cannot be
		 * claimed, and `hot-desk.service.ts` refuses the login. That is the right default for a
		 * feature whose whole effect is "send this person's calls to a phone they are standing at" —
		 * the alternative, an ungated login, would let anyone in the building take anyone's calls.
		 *
		 * A single-column reference with `ON DELETE SET NULL`, matching `outbound_route.pin_set_id`
		 * exactly rather than taking a tenant-composite key. The composite form is always `cascade`
		 * (`tenant.ts` says why), and cascading here would DELETE THE EXTENSION when somebody retired
		 * a code list. `set null` is also the fail-closed direction: losing the set stops the
		 * extension being hot-deskable rather than making it claimable with no PIN at all. The
		 * cross-tenant reference the composite key would have prevented is instead prevented where
		 * `pin_set_id` already is — `assertDestinations`/the resource guard on the write path.
		 */
		hotDeskPinSetId: uuidEntityId("hot_desk_pin_set_id").references(() => pinSet.id, {
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
		/**
		 * The target of the tenant-composite foreign keys that reference this table.
		 *
		 * PostgreSQL evaluates referential integrity with RLS bypassed, and a policy only
		 * constrains a row's OWN `organization_id` — so a single-column reference to `id` lets one
		 * tenant point a row at another tenant's row and nothing in the database objects. Every
		 * child references `(organization_id, id)` instead, which needs this unique index.
		 */
		uniqueIndex("extension_organization_id_key").on(table.organizationId, table.id),
		index("extension_organization_hot_desk_pin_set_idx").on(
			table.organizationId,
			table.hotDeskPinSetId,
		),
		check(
			"extension_outbound_caller_id_presentation_check",
			sql`outbound_caller_id_presentation in ('allowed', 'restricted')`,
		),
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
		extensionId: uuidEntityId("extension_id").notNull(),
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
		tenantCompositeForeignKey({
			name: "extension_user_extension_fk",
			columns: [table.organizationId, table.extensionId],
			foreignColumns: [extension.organizationId, extension.id],
		}),
		tenantIsolationPolicy("extension_user"),
	],
);
