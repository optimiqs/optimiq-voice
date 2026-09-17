import { z } from "zod";

/**
 * Small, closed telephony vocabularies the event contract owns.
 *
 * ## Where a value domain lives (the drift rule)
 *
 * | Domain                                        | Owner                | Why                              |
 * | --------------------------------------------- | -------------------- | -------------------------------- |
 * | leg side, direction, hangup side, transport,   | **this package**     | Tiny, closed, and stable since   |
 * | DTMF source, bridge mode, recording kind,      |                      | Q.931. Every plane needs them,   |
 * | agent status                                  |                      | not just the CDR.                |
 * | hangup CAUSE (66 names), destination type,     | `@optimiq-voice/`    | Large, routing-significant and   |
 * | disposition                                   | `cdr-db`             | still growing. See below.        |
 *
 * `packages/events` must not depend on a database package — the whole point of the backbone is
 * that `apps/sipd` and `apps/mediad` (Go) and every TS service share one contract without
 * dragging Drizzle and a Postgres driver behind it. So the cdr-owned domains are modelled here as
 * *shape-constrained strings* and validated for membership by the CDR writer, which already
 * depends on `cdr-db`. That also means adding a hangup cause is a one-package change.
 *
 * When `packages/telephony` lands (plan §3.3) it becomes the shared home for all of these and
 * both `events` and `cdr-db` depend on it; until then this table is the contract.
 */

/** A-leg is the originating/inbound side; B-leg is every leg the engine originated for it. */
export const LEG_SIDES = ["a", "b"] as const;
export type LegSide = (typeof LEG_SIDES)[number];
export const legSideSchema = z.enum(LEG_SIDES);

/** Direction as the organization sees it, not as the switch sees it. */
export const CALL_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];
export const callDirectionSchema = z.enum(CALL_DIRECTIONS);

/** Which side tore the call down; `system` covers engine/media timeouts and admin hangups. */
export const HANGUP_SIDES = ["caller", "callee", "system"] as const;
export type HangupSide = (typeof HANGUP_SIDES)[number];
export const hangupSideSchema = z.enum(HANGUP_SIDES);

/**
 * Bridge modes. This is `packages/telephony`'s runtime vocabulary (`bridge.ts`), not the frozen
 * reference's — the two disagreed (`full`/`bypass-media` vs `media`/`bypass`), and a `BridgeMode`
 * that crosses the wire must round-trip into the type the engine actually enforces
 * (`MediaPort.bridgeMode` gates recording on it). One vocabulary, owned by the runtime.
 */
export const BRIDGE_MODES = ["media", "proxy-media", "signal-only", "bypass"] as const;
export type BridgeMode = (typeof BRIDGE_MODES)[number];
export const bridgeModeSchema = z.enum(BRIDGE_MODES);

/** DTMF transports, from the frozen reference §4. */
export const DTMF_SOURCES = ["rfc2833", "info", "inband", "application"] as const;
export type DtmfSource = (typeof DTMF_SOURCES)[number];
export const dtmfSourceSchema = z.enum(DTMF_SOURCES);

/** A single DTMF symbol: 0-9, `*`, `#`, or the A-D signalling digits. */
export const dtmfDigitSchema = z.string().regex(/^[0-9*#A-D]$/, "expected one DTMF digit");

/** What produced a stored media object. Mirrors `cdr-db` `RECORDING_KINDS`. */
export const RECORDING_KINDS = ["call", "voicemail", "conference"] as const;
export type RecordingKind = (typeof RECORDING_KINDS)[number];
export const recordingKindSchema = z.enum(RECORDING_KINDS);

/**
 * How a call was handed to a new party (frozen reference §3).
 *
 * `blind` re-routes the transferee and the transferor walks away; `attended` keeps a consultation
 * leg first. The pair is a routing-significant fact rather than a cosmetic one — a completed
 * transfer leaves `BLIND_TRANSFER` (800) or `ATTENDED_TRANSFER` (801) on the transferor's leg, and
 * a report that could not tell them apart could not tell a warm handover from a dumped call.
 */
export const TRANSFER_KINDS = ["blind", "attended"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
export const transferKindSchema = z.enum(TRANSFER_KINDS);

/**
 * How a parked call left its orbit slot.
 *
 * Three outcomes that sound identical on the wire and mean completely different things in a
 * report: somebody collected the call, the parker forgot it and it rang back, or the caller gave
 * up. Collapsing them into "the park ended" is how a lot with a broken timeout looks healthy.
 */
export const PARK_END_REASONS = ["retrieved", "timeout", "abandoned"] as const;
export type ParkEndReason = (typeof PARK_END_REASONS)[number];
export const parkEndReasonSchema = z.enum(PARK_END_REASONS);

/**
 * Which pickup feature answered somebody else's ringing phone.
 *
 * `directed` names the extension (`**200`); `group` takes whatever is ringing in the caller's own
 * pickup group (`*8`). They are separated because "who was allowed to answer that" is an audit
 * question, and a group pickup is an authorisation derived from membership rather than from the
 * digits dialled.
 */
export const PICKUP_KINDS = ["directed", "group"] as const;
export type PickupKind = (typeof PICKUP_KINDS)[number];
export const pickupKindSchema = z.enum(PICKUP_KINDS);

/** How a recording ended. */
export const RECORDING_STOP_REASONS = ["completed", "cancelled", "failed"] as const;
export type RecordingStopReason = (typeof RECORDING_STOP_REASONS)[number];
export const recordingStopReasonSchema = z.enum(RECORDING_STOP_REASONS);

/** SIP transports the edge accepts. */
export const SIP_TRANSPORTS = ["udp", "tcp", "tls", "ws", "wss"] as const;
export type SipTransport = (typeof SIP_TRANSPORTS)[number];
export const sipTransportSchema = z.enum(SIP_TRANSPORTS);

/**
 * What a supervisor is doing to a call they did not place.
 *
 * The three terms every PBX in the industry uses, and they are three POINTS on the same two axes
 * rather than three features: what the supervisor hears, and who can hear the supervisor. Naming
 * them here rather than deriving them from the `hear`/`speakTo` pair keeps the audit trail
 * readable — "extension 1001 barged into call X" is a sentence a compliance officer can act on,
 * and `{hear: "both", speakTo: "both"}` is one they would have to decode.
 *
 * - `eavesdrop` — hear both parties, speak to neither. Silent monitoring.
 * - `whisper` — hear both, speak only to the agent. Coaching; the customer hears nothing.
 * - `barge` — hear both, speak to both. A third party in the conversation.
 */
export const TAP_MODES = ["eavesdrop", "whisper", "barge"] as const;
export type TapMode = (typeof TAP_MODES)[number];
export const tapModeSchema = z.enum(TAP_MODES);

/**
 * How a supervisor's tap ended.
 *
 * `target-ended` and `supervisor-ended` are the two normal outcomes and they are NOT the same
 * fact: the first says the monitored call finished on its own, the second says the supervisor
 * stopped listening while it carried on. A compliance report that collapsed them could not answer
 * "was the rest of that call unmonitored?".
 */
export const TAP_END_REASONS = ["supervisor-ended", "target-ended", "escalated", "failed"] as const;
export type TapEndReason = (typeof TAP_END_REASONS)[number];
export const tapEndReasonSchema = z.enum(TAP_END_REASONS);

/** ACD agent status. Drives queue distribution and the wallboard. */
export const AGENT_STATUSES = [
	"logged-out",
	"available",
	"ringing",
	"on-call",
	"wrap-up",
	"on-break",
	"unavailable",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const agentStatusSchema = z.enum(AGENT_STATUSES);

/**
 * A hangup cause NAME.
 *
 * **Authority: `packages/cdr-db/src/hangup-causes.ts`** (`HANGUP_CAUSES` — the full Q.850 named
 * subset plus the FreeSWITCH extensions, per the frozen reference §6). This schema deliberately
 * validates the SHAPE only, not membership, for the dependency reason in this file's header and
 * because routing keys off causes that carriers keep inventing: an unrecognised cause must reach
 * the CDR writer (which stores the numeric `causeCode` verbatim and falls back to
 * `NORMAL_UNSPECIFIED`) rather than being terminated at the broker edge.
 */
export const hangupCauseSchema = z
	.string()
	.min(1)
	.max(48)
	.regex(/^[A-Z][A-Z0-9_]*$/, "hangup cause must be SCREAMING_SNAKE_CASE (see cdr-db)");

/** Q.850 code (1-127) or a FreeSWITCH extension (487, 702, 800-813). `0` = none recorded. */
export const hangupCauseCodeSchema = z.int().min(0).max(1023);

/**
 * What a routing decision resolved to. **Authority: `cdr-db` `CALL_DESTINATION_TYPES`** (snake)
 * and `pbx-db`/`routing` destination kinds (kebab). Kept as a constrained string here for the
 * same reason as {@link hangupCauseSchema}: new destination types arrive with new PBX features
 * and must not require an `events` release.
 */
export const destinationTypeSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[a-z][a-z_-]*$/, "destination type must be lower snake_case or kebab-case");

/** Reporting outcome of a leg. **Authority: `cdr-db` `CALL_DISPOSITIONS`.** */
export const dispositionSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[a-z][a-z-]*$/, "disposition must be kebab-case (see cdr-db)");

/** A dialable number or SIP user part. Never normalised here — the engine owns E.164 policy. */
export const dialStringSchema = z.string().min(1).max(128);

/** A normalised MAC address: 12 lower-case hex characters, no separators. */
export const macAddressSchema = z
	.string()
	.regex(/^[0-9a-f]{12}$/, "MAC must be 12 lower-case hex characters, no separators");
