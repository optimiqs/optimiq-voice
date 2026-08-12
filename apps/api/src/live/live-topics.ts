import { hasPermission, type Permission } from "@optimiq-voice/auth";

/**
 * The live channel's topic grammar, and the permission each topic is gated on.
 *
 * ## Why topics are a closed vocabulary and not a subject filter
 *
 * The obvious design is to let a client subscribe to a NATS subject filter and check permissions
 * against it. It is also how a client ends up subscribing to `>` and how a permission check ends up
 * being a pattern-matching problem. A closed set of named topics means the mapping from "what the
 * client asked for" to "what may be read" is a lookup, the upstream subjects are chosen by the
 * server, and the organization id is never something the client sends — it comes from the session,
 * exactly as it does on every REST route (oikos §4: no controller accepts a tenant from a caller).
 *
 * ## The permission mapping, and why each one
 *
 * | Topic            | Permission         | Reasoning                                              |
 * | ---------------- | ------------------ | ------------------------------------------------------ |
 * | `registrations`  | `extensions.read`  | A registration is an extension's device being reachable |
 * | `active-calls`   | `cdr.read`         | The live view of what call history shows afterwards     |
 * | `queue:<id>`     | `queues.monitor`   | Literally "Watch live queue and agent state"            |
 * | `agent-state`    | `queues.monitor`   | Same surface, org-wide rather than per queue            |
 * | `voicemail`      | `voicemail.read`   | The counts, which is strictly less than the list        |
 * | `trunks`         | `trunks.read`      | A status transition is one row of the trunk list, sooner |
 *
 * `trunks → trunks.read` follows the voicemail argument exactly: the topic carries
 * `trunk.evt.v1.<org>.<trunk>.status.changed`, whose payload is a status word, a reason and a
 * round-trip time — the same columns `GET /trunks` already returns to anyone holding
 * `trunks.read`. Gating "the same row, sooner" more tightly than the list would protect nothing
 * while making the status pill disagree with the page under it; gating it more loosely would leak
 * the carrier roster to roles that may not see it.
 *
 * `voicemail → voicemail.read` needs no argument at all, and that is the point of saying so: the
 * topic carries `voicemail.evt.v1.<org>.<mailbox>.mwi.updated`, whose whole payload is a mailbox
 * number and two counts. Anyone who may LIST a mailbox already sees both numbers and every message
 * behind them, so gating the live count more tightly than the list would protect nothing while
 * making the badge disagree with the page under it. Note what it does NOT carry: `message.left` is
 * on the same subject root but is filtered out upstream (see `live-hub.service.ts`), because its
 * payload is a caller's number, an object key and a duration — the message itself, not a count.
 *
 * `registrations → extensions.read` rather than `devices.read`: the bucket is keyed by AOR and an
 * AOR is an extension, so an operator who may not see the extension list must not be handed a live
 * feed of which of them are online — that feed IS the extension list, one field wider.
 *
 * `active-calls → cdr.read` is the one worth arguing with, and the argument for it is that there is
 * no honest alternative. The registry has no `calls.*` resource, and a live call feed carries
 * exactly what `cdr.read` grants after the fact — who called whom, from where, for how long — with
 * the only difference being latency. Gating "the same data, sooner" more loosely than "the same
 * data, later" would be a hole; gating it on a NEW permission would mean the ninety-first entry in
 * a registry at its documented ceiling, for a distinction nobody has asked for. Recorded here so
 * that when a wallboard role does need calls without history, adding `calls.monitor` is a
 * deliberate change to one table rather than a rediscovery.
 *
 * Note what falls out of this for the `agent` role, and that it is the intended shape: an agent
 * holds `queues.monitor` and `queues.read` but only `extensions.read.own` and `cdr.read.own`, and
 * `hasPermission` does not let a scoped grant satisfy an unscoped requirement. So an agent's
 * console sees its queues and its own state, and is refused the registrations and active-calls
 * feeds — which is exactly the wallboard/agent split the role templates already describe.
 */

export const LIVE_TOPIC_KINDS = [
	"registrations",
	"active-calls",
	"queue",
	"agent-state",
	"voicemail",
	"trunks",
] as const;
export type LiveTopicKind = (typeof LIVE_TOPIC_KINDS)[number];

/** A parsed topic. `queue` is the only one that carries an id. */
export type LiveTopic =
	| { readonly kind: "registrations" }
	| { readonly kind: "active-calls" }
	| { readonly kind: "agent-state" }
	| { readonly kind: "voicemail" }
	| { readonly kind: "trunks" }
	| { readonly kind: "queue"; readonly queueId: string };

export const LIVE_TOPIC_PERMISSIONS = {
	registrations: "extensions.read",
	"active-calls": "cdr.read",
	queue: "queues.monitor",
	"agent-state": "queues.monitor",
	voicemail: "voicemail.read",
	trunks: "trunks.read",
} as const satisfies Record<LiveTopicKind, Permission>;

/**
 * The upstream this server has to be reading for a topic to produce anything.
 *
 * One topic can need two (`active-calls` reads the `channels` bucket for state AND the call event
 * stream for transitions, because a bucket says what IS and a stream says what CHANGED, and a
 * wallboard that only had the first would redraw a whole table to show one leg answering). Sources
 * are ref-counted independently, so two topics sharing one open it once.
 */
export const LIVE_SOURCES = [
	"registrations-kv",
	"channels-kv",
	"call-events",
	"agent-state-kv",
	"queue-waiting-kv",
	"queue-events",
	"voicemail-events",
	"trunk-events",
] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];

export const LIVE_TOPIC_SOURCES = {
	registrations: ["registrations-kv"],
	"active-calls": ["channels-kv", "call-events"],
	/**
	 * Three sources, and each answers a question the other two cannot.
	 *
	 * `queue-waiting-kv` is the LINE — who is holding, in what order, and since when — so a wallboard
	 * gets waiting-count, positions and longest-wait from one snapshot frame and a watch, instead of
	 * reconstructing them by replaying joins and abandonments it may have missed. `agent-state-kv` is
	 * the roster's live half. `queue-events` is what CHANGED, which is what turns "an agent answered"
	 * into a row that moves rather than a table that redraws.
	 */
	queue: ["queue-events", "agent-state-kv", "queue-waiting-kv"],
	"agent-state": ["agent-state-kv", "queue-events"],
	/**
	 * One source, and no bucket behind it.
	 *
	 * There is no `voicemail` KV projection to snapshot from, on purpose: the counts live in
	 * `voicemail_message` and the page that renders them has already fetched them over HTTP
	 * (`GET /voicemail-boxes/:id/messages` returns `mailbox.newCount`). A bucket would be a third
	 * copy of a number two places already agree on. The stream is what tells an open page the
	 * number changed while somebody was looking at it.
	 */
	voicemail: ["voicemail-events"],
	/**
	 * One source, and no bucket behind it, on exactly the voicemail argument above: the current
	 * statuses live in the `trunk.status*` columns and the trunk list has already fetched them
	 * over HTTP. The stream is what tells an open page a carrier's status moved while somebody
	 * was looking at it.
	 */
	trunks: ["trunk-events"],
} as const satisfies Record<LiveTopicKind, readonly LiveSource[]>;

/** A UUID, which is what every queue id on this platform is (`packages/identifiers`). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Parses a wire topic.
 *
 * Returns `undefined` rather than throwing, and rejects a `queue:` whose id is not a UUID — which
 * is both a validation and a safety check, because the id becomes a NATS subject token and a value
 * that is not one would either throw inside the subject builder or, worse, build a filter with a
 * wildcard in it.
 */
export function parseLiveTopic(value: string): LiveTopic | undefined {
	if (
		value === "registrations" ||
		value === "active-calls" ||
		value === "agent-state" ||
		value === "voicemail" ||
		value === "trunks"
	) {
		return { kind: value };
	}
	const queuePrefix = "queue:";
	if (value.startsWith(queuePrefix)) {
		const queueId = value.slice(queuePrefix.length);
		return UUID_PATTERN.test(queueId) ? { kind: "queue", queueId } : undefined;
	}
	return undefined;
}

/** The canonical wire form. Used as the map key, so it must round-trip `parseLiveTopic`. */
export function formatLiveTopic(topic: LiveTopic): string {
	return topic.kind === "queue" ? `queue:${topic.queueId}` : topic.kind;
}

export function permissionForTopic(topic: LiveTopic): Permission {
	return LIVE_TOPIC_PERMISSIONS[topic.kind];
}

export function sourcesForTopic(topic: LiveTopic): readonly LiveSource[] {
	return LIVE_TOPIC_SOURCES[topic.kind];
}

/**
 * Whether a caller may subscribe.
 *
 * `hasPermission` is the same predicate the HTTP guard uses, including its rule that an unscoped
 * grant covers its scopes and a scoped one never covers the unscoped requirement. That direction is
 * the whole gate here: `cdr.read.own` means "calls you were on", and there is no per-connection
 * filter that could turn an org-wide live feed into that.
 */
export function mayReadTopic(granted: Iterable<string>, topic: LiveTopic): boolean {
	return hasPermission(granted, permissionForTopic(topic));
}

/** The topics a caller could subscribe to at all, for the `welcome` frame. */
export function allowedTopicKinds(granted: Iterable<string>): readonly LiveTopicKind[] {
	return LIVE_TOPIC_KINDS.filter((kind) => hasPermission(granted, LIVE_TOPIC_PERMISSIONS[kind]));
}
