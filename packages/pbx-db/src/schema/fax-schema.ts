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
import { phoneNumber } from "./numbers-schema";

/**
 * Fax — the carrier-edge fax server and its inbox/outbox.
 *
 * # Why this is two tables and why neither is a call leg
 *
 * A fax is not carried in this platform's media plane: mediad has no T.38 gateway and no CNG/CED
 * tone detector (rung 8, absent — `plans/parity-audit-2026-08-11.md` rows 2.27, 4.20). Fax is
 * routed at the **carrier edge** — Telnyx receives an inbound fax, renders it to a document, and
 * webhooks us; and we hand Telnyx a document to send. So a `fax_message` is a *document with a
 * delivery outcome*, not a channel: it belongs in its own table, never in the CDR, because it never
 * occupied a leg here. (A future rung-8 T.38 passthrough that DID occupy a channel would be a CDR
 * leg in addition to a `fax_message`; that is out of scope this wave.)
 *
 * # `fax_server` binds to a DID that is already `fax_enabled`
 *
 * `phone_number.fax_enabled` stays the "this DID can receive fax" flag. A `fax_server` is the
 * org-level policy around such a DID: the number it sends as and receives on, the header text, where
 * inbound faxes are emailed, the retry policy for outbound, and the internal extension number the
 * document is reachable at. The DID reference is nullable and `on delete set null` because a fax
 * server can be configured before a number is bound, and releasing the number must not delete the
 * server's history — the `fax_message` rows outlive the binding.
 */

/** A fax message is either received on the DID or sent from it. Switched on by both workers. */
export const FAX_DIRECTIONS = ["inbound", "outbound"] as const;
export type FaxDirection = (typeof FAX_DIRECTIONS)[number];

/**
 * Where a `fax_message` is in its lifecycle.
 *
 * Outbound walks `queued → sending → delivered | failed`; inbound is filed straight as `received`
 * (the carrier already did the receiving), with `receiving` reserved for a future in-progress
 * inbound notification. `queued` is the safe off-state an outbound row is inserted in — the send
 * worker is the only thing that moves it to `sending`, so a queue is never implied by a default.
 * `delivered`/`failed`/`received` are terminal.
 */
export const FAX_MESSAGE_STATUSES = [
	"queued",
	"sending",
	"delivered",
	"failed",
	"receiving",
	"received",
] as const;
export type FaxMessageStatus = (typeof FAX_MESSAGE_STATUSES)[number];

export const faxServer = pgTable.withRLS(
	"fax_server",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/**
		 * Internal number the fax server is reachable at, when it has one. Nullable for the same
		 * reason a paging group's is: a server that only sends and receives on its DID, with no
		 * internal dial target, must not be forced to invent a number that then collides with an
		 * extension.
		 */
		extensionNumber: text("extension_number"),
		/**
		 * The DID this server sends as and receives on. Nullable + `set null` so the server can be
		 * configured before a number is bound and so releasing the number leaves the server (and its
		 * message history) intact rather than cascading a delete through the outbox.
		 */
		phoneNumberId: uuidEntityId("phone_number_id").references(() => phoneNumber.id, {
			onDelete: "set null",
		}),
		/** Text stamped across the top of each sent page (the "fax header"). */
		headerText: text("header_text"),
		/** Fax-to-email: where a received fax is delivered as a document link. Null disables it. */
		emailToAddress: text("email_to_address"),
		/**
		 * Email-to-fax: the inbound address that turns an emailed attachment into an outbound fax.
		 *
		 * This is the SEAM, not a running feature. There is no inbound MTA in this platform, so nothing
		 * yet reads a mailbox at this address and calls the send path — that is the documented gap (an
		 * MTA/inbound-email hook). The column defines where such a hook would deliver, and the outbound
		 * send path it would call is real; only the ingress is absent.
		 */
		emailFromAddress: text("email_from_address"),
		/**
		 * How many times the send worker may attempt an outbound fax before it is terminally `failed`.
		 * The retry policy lives on the server so an operator sets it once per fax line.
		 */
		retryAttempts: integer("retry_attempts").notNull().default(3),
		/** Base backoff between send attempts, in seconds. */
		retryBackoffSeconds: integer("retry_backoff_seconds").notNull().default(60),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("fax_server_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("fax_server_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		/** One fax server per DID: a number cannot be two fax lines at once. */
		uniqueIndex("fax_server_organization_phone_number_key")
			.on(table.organizationId, table.phoneNumberId)
			.where(sql`phone_number_id is not null`),
		index("fax_server_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("fax_server"),
	],
);

/**
 * One fax, inbound or outbound. The document itself lives in object storage under `object_key`; the
 * row carries the metadata needed to list a mailbox without touching storage, the carrier
 * correlation id, and — for outbound — the send worker's claim and attempt bookkeeping.
 */
export const faxMessage = pgTable.withRLS(
	"fax_message",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		faxServerId: uuidEntityId("fax_server_id")
			.notNull()
			.references(() => faxServer.id, { onDelete: "cascade" }),
		direction: text("direction").$type<FaxDirection>().notNull(),
		status: text("status").$type<FaxMessageStatus>().notNull().default("queued"),
		/** E.164, "+" included, same convention as `phone_number.e164`. */
		fromE164: text("from_e164").notNull(),
		toE164: text("to_e164").notNull(),
		pages: integer("pages"),
		/**
		 * Object-store key for the document (PDF or TIFF). Filled for an inbound fax once its media has
		 * been downloaded from the carrier; null for an outbound row, whose source is a URL the carrier
		 * fetches (see {@link sourceMediaUrl}) rather than a document this platform stores.
		 */
		objectKey: text("object_key"),
		/**
		 * Outbound only: the URL the carrier fetches the document from. This is what an outbound row
		 * carries instead of an `object_key` — the send hands Telnyx a `media_url`, and storing the URL
		 * rather than downloading-then-re-presigning is what keeps the send worker free of a dependency
		 * on a presign-capable object store. Null for every inbound row and for a queued outbound row
		 * whose source has not been set.
		 */
		sourceMediaUrl: text("source_media_url"),
		/**
		 * The Telnyx fax id, for correlation with the `fax.*` webhooks. Unique per org so a redelivered
		 * inbound `fax.received` files the document exactly once — the dedupe key for inbound.
		 */
		telnyxFaxId: text("telnyx_fax_id"),
		/** Human sentence for a terminal `failed`, straight from the carrier's `failure_reason`. */
		errorReason: text("error_reason"),
		/**
		 * How many times the send worker has claimed this outbound row. Incremented by the CLAIM, not
		 * by the carrier call, so a process that dies mid-send still spent an attempt — otherwise a fax
		 * that kills the worker is claimed forever. Past the server's `retry_attempts` the send stops,
		 * which is what makes `failed` terminal for a document the carrier will never accept.
		 */
		attempts: integer("attempts").notNull().default(0),
		/**
		 * When the send worker last claimed this row. The whole of the outbound queue's concurrency
		 * control, released by expiry rather than explicitly — a crashed worker releases nothing. Null
		 * for every inbound row and every unclaimed outbound one.
		 */
		claimedAt: utcTimestamp("claimed_at"),
		/** When an inbound fax was received / an outbound fax reached a terminal state. */
		completedAt: utcTimestamp("completed_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		index("fax_message_server_created_idx").on(
			table.organizationId,
			table.faxServerId,
			table.createdAt,
		),
		index("fax_message_organization_status_idx").on(table.organizationId, table.status),
		/** Redelivery guard: a carrier fax id is filed at most once per tenant. */
		uniqueIndex("fax_message_organization_telnyx_fax_id_key")
			.on(table.organizationId, table.telnyxFaxId)
			.where(sql`telnyx_fax_id is not null`),
		/**
		 * The outbound send queue's index: "which outbound faxes ANYWHERE still owe a send attempt".
		 *
		 * Global on purpose — leading with `organization_id` would be actively wrong. The send worker
		 * runs on the untenanted handle with no session organization and asks its question across every
		 * tenant, exactly like the projection outbox and the transcription back-fill; an
		 * organization-first index could only be scanned in full for that query, while this partial
		 * index over the two working statuses is the size of the backlog, normally near-empty.
		 * `claimed_at` is the second column because every eligibility predicate ends in a comparison
		 * against it.
		 */
		index("fax_message_send_queue_idx")
			.on(table.status, table.claimedAt)
			.where(sql`direction = 'outbound' and status in ('queued', 'sending')`),
		tenantIsolationPolicy("fax_message"),
	],
);
