/**
 * Channel shape — caller profile, flags, and the snapshot the engine keeps per leg.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §1 (session/channel split,
 * per-hop caller profile, channel flags) and §7 (variable scopes).
 *
 * A **session** is the runtime container (fibers, media handles, queues) and stays in the engine.
 * A **channel** is the signaling/state view of one leg, and that is what this file models: it is
 * pure data, serialisable, and safe to put in NATS KV for failover and drain.
 */

import type { CallState } from "./call-state";
import type { ChannelState } from "./channel-state";
import type { HangupCause } from "./hangup-causes";

/** Which way the leg was set up: `inbound` arrived at us, `outbound` we originated. */
export const CHANNEL_DIRECTIONS = ["inbound", "outbound"] as const;

export type ChannelDirection = (typeof CHANNEL_DIRECTIONS)[number];

/**
 * Boolean facts about a channel that are orthogonal to its state (§1 "Key flags").
 *
 * They are flags rather than states precisely because they combine: a leg can be `answered` and
 * `bridged` and `hold` and `attended-transfer` at the same instant, and collapsing that into one
 * enum is how transfer bugs are born.
 *
 * - `answered` — 200 OK has been sent/received; billing has started.
 * - `outbound` — mirrors {@link ChannelDirection}; kept as a flag for cheap set membership.
 * - `early-media` — 183 with SDP: audio before answer, not billable.
 * - `bridged` — currently joined to another leg.
 * - `hold` — on hold, MOH being served.
 * - `transfer` — a transfer is in progress on this leg.
 * - `attended-transfer` — that transfer is the attended kind (a consultation leg exists).
 * - `redirect` — the leg was or is being redirected (SIP 3xx / deflect).
 * - `park` — parked in a lot or orbit slot.
 * - `proxy-mode` — media is bypassed for this leg (SDP passthrough).
 * - `proxy-media` — media is relayed but not decoded.
 * - `video` — a video stream is negotiated.
 */
export const CHANNEL_FLAGS = [
	"answered",
	"outbound",
	"early-media",
	"bridged",
	"hold",
	"transfer",
	"attended-transfer",
	"redirect",
	"park",
	"proxy-mode",
	"proxy-media",
	"video",
] as const;

export type ChannelFlag = (typeof CHANNEL_FLAGS)[number];

/**
 * Scope of a channel variable (§7).
 *
 * - `channel` — local to this leg.
 * - `export` — copied onto every leg this channel originates. This is how caller-id overrides and
 *   routing decisions reach a B-leg; it is also the classic way to leak a tenant's data into
 *   another tenant's leg, so the routing compiler allow-lists what may be exported.
 * - `global` — process/deployment-wide. Never tenant data.
 */
export const VARIABLE_SCOPES = ["channel", "export", "global"] as const;

export type VariableScope = (typeof VARIABLE_SCOPES)[number];

/**
 * The identity and routing context of a call at one routing hop (§1 "Caller profile").
 *
 * A new profile is pushed on every hop (transfer, `execute_extension`, forward), so the history is
 * a stack, not a mutation — that is what makes "who originally dialled what" answerable after
 * three transfers.
 */
export type CallerProfile = {
	readonly callerIdName?: string;
	readonly callerIdNumber?: string;
	/** Automatic Number Identification: the original calling number, unchanged by forwarding. */
	readonly ani?: string;
	/** Redirecting Number Identification: who forwarded the call to this destination. */
	readonly rdnis?: string;
	/** The number being routed on at this hop. */
	readonly destinationNumber: string;
	/** Routing namespace and security boundary (§7). Unauthenticated traffic never gets a
	 * trunk-capable context. */
	readonly context: string;
	/** Signaling peer address as seen by the SIP edge. */
	readonly networkAddr?: string;
	/** What created this hop (`inbound-route`, `transfer`, `follow-me`, …). */
	readonly source?: string;
	/** Human-readable channel name for logs and `show channels` output. */
	readonly channelName?: string;
};

/**
 * The serialisable view of one leg. This is the value written to the `channels` KV bucket, so the
 * engine can be drained and another instance can pick up presence and reporting.
 *
 * Timestamps are epoch milliseconds — no `Date`, so the shape survives JSON without a reviver.
 */
export type ChannelSnapshot = {
	readonly channelId: string;
	/** Groups the A-leg and every leg originated for it. */
	readonly callId: string;
	readonly organizationId: string;
	readonly direction: ChannelDirection;
	readonly state: ChannelState;
	readonly callState: CallState;
	readonly flags: readonly ChannelFlag[];
	readonly profile: CallerProfile;
	/** Channel-scoped variables. Export-scoped values are applied to originated legs, not stored here. */
	readonly variables: Readonly<Record<string, string>>;
	/** The bridge this leg is part of, when bridged. */
	readonly bridgeId?: string;
	readonly createdAt: number;
	readonly answeredAt?: number;
	readonly hangupAt?: number;
	readonly hangupCause?: HangupCause;
};

const CHANNEL_DIRECTION_SET = new Set<string>(CHANNEL_DIRECTIONS);
const CHANNEL_FLAG_SET = new Set<string>(CHANNEL_FLAGS);
const VARIABLE_SCOPE_SET = new Set<string>(VARIABLE_SCOPES);

/** Type guard for a direction arriving from the wire. */
export function isChannelDirection(value: string): value is ChannelDirection {
	return CHANNEL_DIRECTION_SET.has(value);
}

/** Type guard for a flag name arriving from the wire. */
export function isChannelFlag(value: string): value is ChannelFlag {
	return CHANNEL_FLAG_SET.has(value);
}

/** Type guard for a variable scope arriving from a route definition or an API payload. */
export function isVariableScope(value: string): value is VariableScope {
	return VARIABLE_SCOPE_SET.has(value);
}

/** Whether a snapshot carries a flag. */
export function hasChannelFlag(channel: ChannelSnapshot, flag: ChannelFlag): boolean {
	return channel.flags.includes(flag);
}

/**
 * Whether media may flow to/from this leg right now: it has been answered, or early media has been
 * established. Playing audio at a leg that is neither is a no-op at best and a protocol error at
 * worst, which is why `verbRequiresMediaPath` exists in `./verbs`.
 */
export function hasMediaPath(channel: ChannelSnapshot): boolean {
	return hasChannelFlag(channel, "answered") || hasChannelFlag(channel, "early-media");
}
