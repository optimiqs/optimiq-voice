import { boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * Outbound webhook subscriptions — the integrator's half of the event backbone.
 *
 * ## Why a table and not a setting
 *
 * The platform already publishes everything an integrator could want, on JetStream, with thirty
 * days of replay behind it. What it has never had is a way for somebody who is not on the broker to
 * receive any of it: a CRM screen-pop, a wallboard somebody wrote in an afternoon, a Slack message
 * when a queue abandons. That is a row per endpoint, per tenant, with its own secret and its own
 * health — none of which fits in `org_setting`, and all of which an administrator has to be able to
 * list, edit and switch off from a screen.
 *
 * ## The secret is stored, not hashed, and that is the only honest option
 *
 * Every other credential in this database is one-way: `sip_credential` keeps an HA1, `voicemail_box`
 * a scrypt PIN, `device` a token hash. This one cannot be, because the platform is the party that
 * must PRODUCE the signature on every delivery — an HMAC needs the key, not a verifier for it. The
 * mitigations are therefore about blast radius rather than storage: it never leaves the process in a
 * response body (`WEBHOOK_SUBSCRIPTION_RESOURCE.secretColumns`), it is redacted from both sides of
 * the audit diff, it signs one tenant's deliveries to one endpoint, and rotating it is a PATCH.
 *
 * ## `event_selectors` is `jsonb` and not a child table
 *
 * A selector is a NATS subject filter (`calls.evt.v1.>`, or an exact event type), and the list is
 * short, always read whole, and never queried across rows — there is no "which subscriptions want
 * `channel.answered`" index worth having, because the dispatcher matches every live subscription
 * against every message in memory anyway. A child table would buy a join and a second resource for
 * the CRUD surface, and would still be read in its entirety on the same code path.
 *
 * ## The failure bookkeeping is on the row, deliberately
 *
 * `consecutive_failures`, `last_failure_at`, `last_failure_reason` and `auto_disabled_at` are the
 * answer to the only question anybody asks about a webhook — "why did it stop working?" — and they
 * are on the subscription rather than in a deliveries table because a delivery LOG is a different
 * feature with a different retention problem. What is kept here is the CURRENT health, which is one
 * row's worth of state and which the CRUD read surfaces without a second query.
 *
 * There is deliberately no delivery-attempt table yet. It is the obvious follow-up and it is a
 * volume decision (one row per event per subscription) that should be made with a retention policy
 * in hand, not smuggled in behind this.
 */
export const webhookSubscription = pgTable.withRLS(
	"webhook_subscription",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** What this endpoint is, in the administrator's words. */
		description: text("description"),
		/** Where deliveries are POSTed. `https` in production; the API's DTO is what enforces that. */
		url: text("url").notNull(),
		/**
		 * The HMAC-SHA256 signing key, stored because the platform is the signer. See the note above.
		 */
		secret: text("secret").notNull(),
		/**
		 * NATS subject filters, or exact event types, this endpoint wants.
		 *
		 * A JSON array of strings. `calls.evt.v1.>` takes a whole family; `channel.answered` takes one
		 * event across every family that has one. The API validates the vocabulary on write, so a
		 * selector that could never match anything is a 400 rather than a subscription that silently
		 * receives nothing.
		 */
		eventSelectors: jsonb("event_selectors").$type<readonly string[]>().notNull().default([]),
		enabled: boolean("enabled").notNull().default(true),
		/**
		 * Consecutive failed deliveries, reset to zero by the first success.
		 *
		 * CONSECUTIVE and not total: a busy endpoint that fails one delivery in a thousand is healthy,
		 * and a counter that only ever went up would disable it eventually for no reason.
		 */
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		lastFailureAt: utcTimestamp("last_failure_at"),
		/** The last failure in one line — a status code, a timeout, a DNS error. Never a body. */
		lastFailureReason: text("last_failure_reason"),
		lastSuccessAt: utcTimestamp("last_success_at"),
		/**
		 * When the platform switched this off on the tenant's behalf.
		 *
		 * Separate from `enabled` rather than folded into it, because the two are different facts: an
		 * administrator who disabled an endpoint knows why, and one who finds it disabled needs to be
		 * told that WE did it and when. Re-enabling through the CRUD surface clears this and the
		 * counter, which is what makes "fix the endpoint, turn it back on" a complete recovery.
		 */
		autoDisabledAt: utcTimestamp("auto_disabled_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		/**
		 * The dispatcher's read: every live subscription in a tenant. It runs on a cache refresh
		 * rather than per message, but it runs for every tenant that has any, so it is worth an index
		 * rather than a sequential scan of the table.
		 */
		index("webhook_subscription_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("webhook_subscription"),
	],
);
