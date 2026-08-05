import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns } from "./columns";
import { extension } from "./extensions-schema";

/**
 * Voicemail. Audio lives in object storage; the row carries the key, the metadata needed to list
 * a mailbox without touching storage, and the transcription.
 *
 * A box does not point at its "active greeting" — the greeting rows carry `active` instead, which
 * avoids a circular foreign key and makes "activate this greeting" a single-table update.
 */

export const VOICEMAIL_FOLDERS = ["new", "saved", "deleted"] as const;
export type VoicemailFolder = (typeof VOICEMAIL_FOLDERS)[number];

export const VOICEMAIL_GREETING_KINDS = ["unavailable", "busy", "name", "temporary"] as const;
export type VoicemailGreetingKind = (typeof VOICEMAIL_GREETING_KINDS)[number];

/** What happens to the message when it is emailed. */
export const VOICEMAIL_EMAIL_MODES = ["none", "notify", "attach"] as const;
export type VoicemailEmailMode = (typeof VOICEMAIL_EMAIL_MODES)[number];

export const voicemailBox = pgTable.withRLS(
	"voicemail_box",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Dialable mailbox number. Usually the extension number, but boxes may be standalone. */
		mailboxNumber: text("mailbox_number").notNull(),
		label: text("label"),
		extensionId: uuidEntityId("extension_id").references(() => extension.id, {
			onDelete: "set null",
		}),
		pinHash: text("pin_hash"),
		emailAddress: text("email_address"),
		emailMode: text("email_mode").$type<VoicemailEmailMode>().notNull().default("none"),
		/** Classic "email and delete" behaviour: the box keeps no copy. */
		deleteAfterDelivery: boolean("delete_after_delivery").notNull().default(false),
		transcriptionEnabled: boolean("transcription_enabled").notNull().default(false),
		mwiEnabled: boolean("mwi_enabled").notNull().default(true),
		maxMessages: integer("max_messages").notNull().default(100),
		maxMessageSeconds: integer("max_message_seconds").notNull().default(300),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("voicemail_box_organization_mailbox_number_key").on(
			table.organizationId,
			table.mailboxNumber,
		),
		index("voicemail_box_organization_extension_idx").on(table.organizationId, table.extensionId),
		tenantIsolationPolicy("voicemail_box"),
	],
);

export const voicemailGreeting = pgTable.withRLS(
	"voicemail_greeting",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		voicemailBoxId: uuidEntityId("voicemail_box_id")
			.notNull()
			.references(() => voicemailBox.id, { onDelete: "cascade" }),
		kind: text("kind").$type<VoicemailGreetingKind>().notNull().default("unavailable"),
		label: text("label"),
		objectKey: text("object_key").notNull(),
		durationMs: integer("duration_ms"),
		/** At most one greeting per kind may be active; enforced by a partial unique index. */
		active: boolean("active").notNull().default(false),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("voicemail_greeting_box_kind_active_key")
			.on(table.organizationId, table.voicemailBoxId, table.kind)
			.where(sql`active`),
		index("voicemail_greeting_organization_box_idx").on(table.organizationId, table.voicemailBoxId),
		tenantIsolationPolicy("voicemail_greeting"),
	],
);

export const voicemailMessage = pgTable.withRLS(
	"voicemail_message",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		voicemailBoxId: uuidEntityId("voicemail_box_id")
			.notNull()
			.references(() => voicemailBox.id, { onDelete: "cascade" }),
		folder: text("folder").$type<VoicemailFolder>().notNull().default("new"),
		callerIdName: text("caller_id_name"),
		callerIdNumber: text("caller_id_number"),
		receivedAt: utcTimestamp("received_at").notNull().defaultNow(),
		durationMs: integer("duration_ms").notNull().default(0),
		objectKey: text("object_key").notNull(),
		sizeBytes: integer("size_bytes"),
		transcription: text("transcription"),
		/** Leg id in the CDR bounded context. Plain UUID: no cross-database foreign keys. */
		callLegRef: uuidEntityId("call_leg_ref"),
		...auditTimestampColumns(),
	},
	(table) => [
		index("voicemail_message_box_folder_received_idx").on(
			table.organizationId,
			table.voicemailBoxId,
			table.folder,
			table.receivedAt,
		),
		index("voicemail_message_organization_received_idx").on(table.organizationId, table.receivedAt),
		tenantIsolationPolicy("voicemail_message"),
	],
);

/** Digit escapes offered while the greeting plays, e.g. "press 0 for the operator". */
export const voicemailOption = pgTable.withRLS(
	"voicemail_option",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		voicemailBoxId: uuidEntityId("voicemail_box_id")
			.notNull()
			.references(() => voicemailBox.id, { onDelete: "cascade" }),
		digit: text("digit").notNull(),
		ordinal: integer("ordinal").notNull().default(1),
		label: text("label"),
		...destinationColumns(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("voicemail_option_box_digit_key").on(
			table.organizationId,
			table.voicemailBoxId,
			table.digit,
		),
		destinationCheck("voicemail_option"),
		tenantIsolationPolicy("voicemail_option"),
	],
);
