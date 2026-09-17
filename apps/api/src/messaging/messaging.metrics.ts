import { Counter } from "prom-client";
import { metricsRegistry } from "../core/metrics/metrics";

/**
 * Messaging counters.
 *
 * # What is counted, and what deliberately is not
 *
 * Every label on every metric here is a CLOSED set — a direction, a status, a refusal reason, an
 * event type. None of them carries a phone number, an organization id, a conversation id or a
 * carrier error string. That is the one rule that matters on a metrics endpoint: a label whose
 * values come from data is a cardinality explosion, and this is the busiest table in the schema.
 * "Which tenant is being filtered" is a question for a log line or a query, not for a time series.
 *
 * # Why refusals are a counter and not just a log
 *
 * `messaging_sends_blocked_total{reason}` is the metric this feature exists to produce. A sudden
 * rise in `not-registered` is a campaign that got suspended overnight; a rise in `opted-out` is a
 * list somebody imported without consent; a rise in `quiet-hours` is a scheduler in the wrong zone.
 * All three are invisible in a send-success rate, because a blocked send never reaches the carrier.
 */

function counter(name: string, help: string, labelNames: readonly string[]): Counter<string> {
	// Idempotent by name, matching `registerGauge`: a harness that builds two applications in one
	// process must not take the whole boot down over a duplicate metric registration.
	const existing = metricsRegistry.getSingleMetric(name);
	if (existing !== undefined) {
		metricsRegistry.removeSingleMetric(name);
	}
	return new Counter({ name, help, labelNames: [...labelNames], registers: [metricsRegistry] });
}

/** Messages accepted by the carrier, by direction. Inbound counts on ingestion. */
export const messagesTotal = counter(
	"api_messaging_messages_total",
	"Messages this platform sent or received, by direction and kind.",
	["direction", "kind"],
);

/** Terminal outcomes of an outbound message, from the delivery receipt. */
export const messageOutcomesTotal = counter(
	"api_messaging_outcomes_total",
	"Terminal outcomes reported for outbound messages by the carrier.",
	["status"],
);

/**
 * Sends refused before they reached the carrier.
 *
 * `reason` is one of `not-registered`, `opted-out`, `quiet-hours`, `disabled`, `not-configured` —
 * the closed set the errors module defines. See the header for why this is the interesting metric.
 */
export const messagingSendsBlocked = counter(
	"api_messaging_sends_blocked_total",
	"Sends refused by a platform-side compliance or registration gate, by reason.",
	["reason"],
);

/** Inbound messages that were a compliance keyword rather than conversation. */
export const messagingKeywordsTotal = counter(
	"api_messaging_keywords_total",
	"Inbound STOP/HELP/START keywords honoured, by intent.",
	["intent"],
);

/** Suppression-list movement. `added` and `removed` are both worth watching. */
export const messagingOptOutsTotal = counter(
	"api_messaging_opt_outs_total",
	"Opt-out ledger changes, by action and source.",
	["action", "source"],
);

/** Webhook deliveries, by outcome — including the ones that failed to verify. */
export const messagingWebhooksTotal = counter(
	"api_messaging_webhooks_total",
	"Inbound carrier webhook deliveries, by outcome.",
	["outcome"],
);

/** Platform events published onto `messaging.evt.v1`. */
export const messagingEventsPublished = counter(
	"api_messaging_events_published_total",
	"Messaging events published to the event backbone, by type.",
	["type"],
);

/** Registration state transitions observed by the poller. */
export const messagingRegistrationTransitions = counter(
	"api_messaging_registration_transitions_total",
	"A2P registration status transitions, by kind and the status moved into.",
	["kind", "status"],
);
