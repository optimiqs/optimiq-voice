import { webhookSubscription } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Outbound webhook subscriptions.
 *
 * ## No destination trio, nothing points at it, no routing effect
 *
 * A webhook endpoint is not a place a call goes and nothing holds a foreign key to it, so both
 * destination fields are empty and there are no scalar references — a delete can never orphan
 * anything. `webhook_subscription` is also absent from `ROUTING_TABLE_TO_ENTITY` and from
 * `QUEUE_MEMBERSHIP_TABLES`, so a write here recompiles nothing and publishes no projection, which
 * is correct: the compiler has no webhook input, and an artifact eviction on every endpoint edit
 * would be cache churn with no consumer. The same shape as `sip_acl_entry`, and for the same
 * reasons.
 *
 * ## `secret` is a secret column, and that is the read half of a two-part rule
 *
 * The write half is the DTO: the secret goes in and is never merged into a response. This is the
 * read half — `PbxResourceService.redact` strips it from every row that leaves the process, and
 * `AuditLogService` drops it from both sides of the change diff while still recording that it
 * CHANGED. So a rotation is visible in the ledger and its value is not, which is exactly the
 * property a signing key needs.
 *
 * The one deliberate exception is the create response, and it is not made here: `WebhooksService`
 * puts the generated secret back onto the row it returns from `create`, once, because a key the
 * administrator cannot read is a key they cannot configure the far end with. Every other path —
 * list, get, update — returns it redacted.
 *
 * ## Search covers the description and the URL
 *
 * Both are what somebody types when looking for an endpoint they set up months ago, and both are
 * text. The selector list is deliberately not searchable: it is `jsonb`, `ilike` over it would
 * match the JSON punctuation as readily as the content, and "which endpoints get
 * `channel.answered`" is a question the selector grammar answers exactly rather than fuzzily.
 */
export const WEBHOOK_SUBSCRIPTION_RESOURCE: PbxResource = {
	kind: "webhook",
	tableName: "webhook_subscription",
	table: webhookSubscription,
	searchColumns: [webhookSubscription.description, webhookSubscription.url],
	orderBy: [webhookSubscription.url, webhookSubscription.id],
	enabledColumn: webhookSubscription.enabled,
	destinations: [],
	destinationType: null,
	secretColumns: ["secret"],
};
