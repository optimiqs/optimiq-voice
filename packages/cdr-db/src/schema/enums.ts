/**
 * CDR value domains.
 *
 * Per the oikos convention these are `as const` tuples backing `text().$type<T>()` columns with
 * `check()` constraints — never `pgEnum`. A Postgres enum cannot gain a value inside a
 * transaction that also uses it, and `ALTER TYPE ... RENAME VALUE` is unavailable on old
 * clusters; a text column plus a check constraint is a one-statement migration.
 */

/** A-leg is the originating/inbound side; B-leg is every leg the engine originated for it. */
export const CALL_LEG_SIDES = ["a", "b"] as const;
export type CallLegSide = (typeof CALL_LEG_SIDES)[number];

/** Direction as seen by the organization, not by the switch. */
export const CALL_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/**
 * What the routing decision resolved to. `destination_ref` holds the pbx-db entity id for the
 * matching type; the two are always written together.
 */
export const CALL_DESTINATION_TYPES = [
	"extension",
	"queue",
	"ivr",
	"ring_group",
	"voicemail",
	"conference",
	"trunk",
	"external",
	"application",
	"time_condition",
	"park",
	"unknown",
] as const;
export type CallDestinationType = (typeof CALL_DESTINATION_TYPES)[number];

/** Which side tore the call down. `system` covers engine/media timeouts and admin hangups. */
export const HANGUP_SIDES = ["caller", "callee", "system"] as const;
export type HangupSide = (typeof HANGUP_SIDES)[number];

/** Reporting outcome of the leg. Authoritative for billing together with `answered_at`. */
export const CALL_DISPOSITIONS = ["answered", "no-answer", "busy", "failed", "voicemail"] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

/** Lifecycle of the async transcription pipeline; a late-arriving field on the leg. */
export const TRANSCRIPTION_STATUSES = [
	"none",
	"pending",
	"processing",
	"completed",
	"failed",
] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

/**
 * Per-leg event log vocabulary — the FreeSWITCH-semantic superset the engine publishes on NATS
 * (`plans/reference/freeswitch-capabilities.md` §8), trimmed to the events worth persisting.
 * Live state is never read from here; this is a forensic trail behind the CDR.
 */
export const CALL_EVENT_TYPES = [
	"created",
	"routing",
	"progress",
	"early-media",
	"answered",
	"bridged",
	"unbridged",
	"held",
	"unheld",
	"parked",
	"unparked",
	"dtmf",
	"transfer",
	"record-started",
	"record-stopped",
	"playback-started",
	"playback-stopped",
	"queue-joined",
	"queue-answered",
	"queue-abandoned",
	"voicemail-left",
	"hangup",
] as const;
export type CallEventType = (typeof CALL_EVENT_TYPES)[number];

/** What produced the stored media object. */
export const RECORDING_KINDS = ["call", "voicemail", "conference"] as const;
export type RecordingKind = (typeof RECORDING_KINDS)[number];
