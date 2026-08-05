/**
 * Bridges — how two legs are joined and how much of the media path we own.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §1 ("Bridge modes: full
 * media (relay+transcode), signal-only (media p2p), bypass-media (SDP passthrough), proxy-media
 * (relay w/o decode). Media can be toggled mid-call (re-INVITE)").
 *
 * The mode is not a performance knob — it decides which features are physically possible. A
 * bypassed bridge has no packets passing through us, so recording, inband DTMF detection,
 * eavesdrop and every media bug in §5 are impossible on it. The predicates below exist so that
 * check is made once, here, instead of being re-derived (and got wrong) in each feature runtime.
 */

import { InvalidBridgeTransitionError } from "./errors";

/**
 * How the media path is arranged for a bridge.
 *
 * - `media` — full media: RTP is relayed through us and decoded, so transcoding, media bugs,
 *   recording, inband DTMF and conferencing all work. The most expensive mode.
 * - `proxy-media` — RTP is relayed through us but never decoded. Keeps NAT/topology control and
 *   raw packet capture, but nothing that needs samples (mixing, transcoding, tone detection).
 * - `signal-only` — we keep the signaling dialog and let the endpoints send RTP peer-to-peer.
 * - `bypass` — SDP is passed through untouched; the endpoints negotiate directly with each other.
 *   Cheapest, and the least recoverable: we cannot re-take the media path without a re-INVITE.
 */
export const BRIDGE_MODES = ["media", "proxy-media", "signal-only", "bypass"] as const;

export type BridgeMode = (typeof BRIDGE_MODES)[number];

/** The mode used unless a route, trunk or feature explicitly asks for something cheaper. */
export const DEFAULT_BRIDGE_MODE = "media" satisfies BridgeMode;

/**
 * Which side of the bridge a leg sits on.
 *
 * `a` is the leg that already existed (the originating/inbound side); `b` is the leg the engine
 * created for it. The roles are fixed for the life of the bridge and are what CDR linkage,
 * `transfer -bleg`, per-leg recording channels and `hangup_after_bridge` all address.
 */
export const LEG_ROLES = ["a", "b"] as const;

export type LegRole = (typeof LEG_ROLES)[number];

/**
 * Bridge lifecycle.
 *
 * - `pending` — both legs are known and the join has been requested; media is not joined yet.
 *   A ring-all dial sits here for every candidate until one answers.
 * - `bridged` — the legs are joined and audio flows per the mode.
 * - `unbridged` — terminal. The legs were separated (hangup, transfer, park, or an explicit
 *   unbridge). A bridge is never re-entered: rejoining the same two legs is a NEW bridge with a
 *   new id, which is what keeps the CDR bridge records unambiguous.
 */
export const BRIDGE_STATES = ["pending", "bridged", "unbridged"] as const;

export type BridgeState = (typeof BRIDGE_STATES)[number];

/** The state a bridge is created in. */
export const INITIAL_BRIDGE_STATE = "pending" satisfies BridgeState;

/**
 * Adjacency of the bridge lifecycle. `unbridged` is terminal (`[]`) — see {@link BRIDGE_STATES}
 * for why re-bridging mints a new id instead of walking back.
 */
export const VALID_BRIDGE_TRANSITIONS = {
	pending: ["bridged", "unbridged"],
	bridged: ["unbridged"],
	unbridged: [],
} as const satisfies Record<BridgeState, readonly BridgeState[]>;

/** Why a bridge ended. Drives the CDR bridge record and whether the surviving leg keeps running. */
export const UNBRIDGE_REASONS = [
	"leg-hangup",
	"transfer",
	"park",
	"replaced",
	"engine-request",
	"media-timeout",
] as const;

export type UnbridgeReason = (typeof UNBRIDGE_REASONS)[number];

/** One leg's participation in a bridge. */
export type BridgeLeg = {
	/** The channel occupying this side of the bridge. */
	readonly channelId: string;
	readonly role: LegRole;
};

/** A bridge as the engine holds it. Timestamps are epoch milliseconds so the shape is portable. */
export type Bridge = {
	readonly bridgeId: string;
	readonly callId: string;
	readonly mode: BridgeMode;
	readonly state: BridgeState;
	readonly legs: readonly [BridgeLeg, BridgeLeg];
	readonly createdAt: number;
	/** Set when the bridge reached `bridged`; `undefined` while `pending`. */
	readonly bridgedAt?: number;
	/** Set when the bridge reached `unbridged`. */
	readonly unbridgedAt?: number;
	readonly unbridgeReason?: UnbridgeReason;
};

/** A mid-call media renegotiation (re-INVITE): the mode a bridge is being moved to, and why. */
export type BridgeModeChange = {
	readonly from: BridgeMode;
	readonly to: BridgeMode;
	/** Which leg is being re-INVITEd; `undefined` means both. */
	readonly leg?: LegRole;
};

const BRIDGE_MODE_SET = new Set<string>(BRIDGE_MODES);
const BRIDGE_STATE_SET = new Set<string>(BRIDGE_STATES);
const LEG_ROLE_SET = new Set<string>(LEG_ROLES);
const RELAYING_MODES = new Set<string>(["media", "proxy-media"]);

/** Type guard for a bridge mode arriving from a route definition, an API payload or KV. */
export function isBridgeMode(value: string): value is BridgeMode {
	return BRIDGE_MODE_SET.has(value);
}

/** Type guard for a bridge state arriving from the wire or a KV snapshot. */
export function isBridgeState(value: string): value is BridgeState {
	return BRIDGE_STATE_SET.has(value);
}

/** Type guard for a leg role arriving from the wire. */
export function isLegRole(value: string): value is LegRole {
	return LEG_ROLE_SET.has(value);
}

/** The other side of the bridge. */
export function oppositeLegRole(role: LegRole): LegRole {
	return role === "a" ? "b" : "a";
}

/** The bridge states reachable in one step. Never `undefined`; `unbridged` returns `[]`. */
export function bridgeTransitionsFrom(state: BridgeState): readonly BridgeState[] {
	return VALID_BRIDGE_TRANSITIONS[state];
}

/** Whether the lifecycle connects `from` to `to` in exactly one step. */
export function isValidBridgeTransition(from: BridgeState, to: BridgeState): boolean {
	return (VALID_BRIDGE_TRANSITIONS[from] as readonly BridgeState[]).includes(to);
}

/**
 * Guard for guard-then-execute: call before mutating the bridge record, never after.
 *
 * @throws {InvalidBridgeTransitionError} when the edge does not exist.
 */
export function assertBridgeTransition(from: BridgeState, to: BridgeState): void {
	if (!isValidBridgeTransition(from, to)) {
		throw new InvalidBridgeTransitionError(from, to);
	}
}

/** `unbridged` only — the single bridge state with no outgoing edges. */
export function isTerminalBridgeState(state: BridgeState): boolean {
	return VALID_BRIDGE_TRANSITIONS[state].length === 0;
}

/** Whether RTP passes through us at all (`media`, `proxy-media`). */
export function bridgeModeRelaysMedia(mode: BridgeMode): boolean {
	return RELAYING_MODES.has(mode);
}

/**
 * Whether we decode the media, i.e. whether we hold actual samples.
 *
 * Only `media` does. Everything in §5 that reads or rewrites audio — recording, eavesdrop,
 * whisper, barge, displace, conference mixing, inband DTMF, tone/VAD/speech detection — requires
 * this to be true.
 */
export function bridgeModeDecodesMedia(mode: BridgeMode): boolean {
	return mode === "media";
}

/** Whether a media bug (the tap primitive powering recording, eavesdrop and detectors) can attach. */
export function supportsMediaBug(mode: BridgeMode): boolean {
	return bridgeModeDecodesMedia(mode);
}

/** Whether a bridge in this mode can be recorded without first re-INVITEing the media back to us. */
export function supportsRecording(mode: BridgeMode): boolean {
	return bridgeModeDecodesMedia(mode);
}

/** Whether the endpoints must be renegotiated (re-INVITE) to move between two modes. */
export function requiresRenegotiation(from: BridgeMode, to: BridgeMode): boolean {
	return from !== to;
}
