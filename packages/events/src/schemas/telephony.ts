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

/** Bridge modes, from `plans/reference/freeswitch-capabilities.md` §1. */
export const BRIDGE_MODES = ["full", "signal-only", "bypass-media", "proxy-media"] as const;
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

/** How a recording ended. */
export const RECORDING_STOP_REASONS = ["completed", "cancelled", "failed"] as const;
export type RecordingStopReason = (typeof RECORDING_STOP_REASONS)[number];
export const recordingStopReasonSchema = z.enum(RECORDING_STOP_REASONS);

/** SIP transports the edge accepts. */
export const SIP_TRANSPORTS = ["udp", "tcp", "tls", "ws", "wss"] as const;
export type SipTransport = (typeof SIP_TRANSPORTS)[number];
export const sipTransportSchema = z.enum(SIP_TRANSPORTS);

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
 * What a routing decision resolved to. **Authority: `cdr-db` `CALL_DESTINATION_TYPES`.** Kept as
 * a constrained string here for the same reason as {@link hangupCauseSchema}: new destination
 * types arrive with new PBX features and must not require an `events` release.
 */
export const destinationTypeSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[a-z][a-z_]*$/, "destination type must be lower_snake_case (see cdr-db)");

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
