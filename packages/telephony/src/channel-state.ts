/**
 * Channel state machine — the engine-internal lifecycle of one call leg.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §1
 * ("`NEW → INIT → ROUTING → EXECUTE → EXCHANGE_MEDIA` with side states
 * `PARK / CONSUME_MEDIA / SOFT_EXECUTE / HIBERNATE`, then `HANGUP → REPORTING → DESTROY`").
 * Names are ours (kebab-case, no FreeSWITCH identifiers survive); the topology is theirs.
 *
 * This is NOT the value BLF subscribers see — that is `./call-state`. A channel can sit in
 * `executing` while the user-visible call state is `ringing`, `early` or `active`; the two
 * machines advance independently and are correlated only by the channel id.
 *
 * Per the oikos convention (`plans/reference/oikos-conventions.md` §4) the machine is a
 * `VALID_TRANSITIONS` const with a terminal state of `[]`, and every mutation is
 * guard-then-execute: `assertChannelTransition` before the write, never after.
 */

import { InvalidChannelTransitionError } from "./errors";

/**
 * Every state a channel can occupy, in canonical lifecycle order.
 *
 * - `created` — the session container exists; nothing has been negotiated.
 * - `initializing` — endpoint/profile setup; caller profile is being built.
 * - `routing` — the routing executor is resolving a destination for the current caller profile.
 *   Re-entered on a blind transfer, which resets the leg into a new context (§3).
 * - `executing` — running verbs / dialplan actions.
 * - `exchanging-media` — a media path is established and audio is flowing (typically bridged).
 * - `parked` — held by the engine with no application driving it (park lots, orbit slots, §3).
 * - `consuming-media` — reading media without executing (eavesdrop targets, detectors, §5).
 * - `soft-executing` — running an action on a leg that another leg currently owns.
 * - `hibernating` — intentionally idle; kept alive for a pending decision (attended-transfer
 *   consultation, recovery) without burning a media path.
 * - `hangup` — teardown started, hangup cause is now fixed.
 * - `reporting` — CDR/event emission after teardown; the leg is no longer routable.
 * - `destroyed` — terminal; the session container is gone.
 */
export const CHANNEL_STATES = [
	"created",
	"initializing",
	"routing",
	"executing",
	"exchanging-media",
	"parked",
	"consuming-media",
	"soft-executing",
	"hibernating",
	"hangup",
	"reporting",
	"destroyed",
] as const;

export type ChannelState = (typeof CHANNEL_STATES)[number];

/** The state every channel starts in. */
export const INITIAL_CHANNEL_STATE = "created" satisfies ChannelState;

/**
 * The teardown tail. Once entered it is one-way: `hangup → reporting → destroyed`, with no edge
 * back into a live state. The hangup cause is immutable from the moment `hangup` is entered, which
 * is what makes the per-leg CDR reproducible from the event stream.
 */
export const CHANNEL_TEARDOWN_STATES = [
	"hangup",
	"reporting",
	"destroyed",
] as const satisfies readonly ChannelState[];

/**
 * Adjacency of the machine.
 *
 * Invariants pinned by `channel-state.spec.ts`:
 * 1. `destroyed` is terminal (`[]`) and is reachable only from `reporting`.
 * 2. `reporting` is reachable only from `hangup`.
 * 3. Every live state can go straight to `hangup` — a leg can always be torn down.
 * 4. No state lists itself (a no-op re-entry is not a transition; the engine must not emit one).
 * 5. Every state is reachable from `created`.
 */
export const VALID_CHANNEL_TRANSITIONS = {
	created: ["initializing", "hangup"],
	initializing: ["routing", "executing", "parked", "consuming-media", "hibernating", "hangup"],
	routing: [
		"executing",
		"exchanging-media",
		"parked",
		"consuming-media",
		"soft-executing",
		"hibernating",
		"hangup",
	],
	executing: [
		"routing",
		"exchanging-media",
		"parked",
		"consuming-media",
		"soft-executing",
		"hibernating",
		"hangup",
	],
	"exchanging-media": [
		"routing",
		"executing",
		"parked",
		"consuming-media",
		"soft-executing",
		"hibernating",
		"hangup",
	],
	parked: ["routing", "executing", "exchanging-media", "consuming-media", "hibernating", "hangup"],
	"consuming-media": [
		"routing",
		"executing",
		"exchanging-media",
		"parked",
		"soft-executing",
		"hibernating",
		"hangup",
	],
	"soft-executing": [
		"routing",
		"executing",
		"exchanging-media",
		"parked",
		"consuming-media",
		"hibernating",
		"hangup",
	],
	hibernating: [
		"routing",
		"executing",
		"exchanging-media",
		"parked",
		"consuming-media",
		"soft-executing",
		"hangup",
	],
	hangup: ["reporting"],
	reporting: ["destroyed"],
	destroyed: [],
} as const satisfies Record<ChannelState, readonly ChannelState[]>;

const CHANNEL_STATE_SET = new Set<string>(CHANNEL_STATES);
const CHANNEL_TEARDOWN_SET = new Set<string>(CHANNEL_TEARDOWN_STATES);

/** Type guard for a channel state arriving from the wire, a KV snapshot or a media adapter. */
export function isChannelState(value: string): value is ChannelState {
	return CHANNEL_STATE_SET.has(value);
}

/** The states reachable in one step from `state`. Never `undefined`; `destroyed` returns `[]`. */
export function channelTransitionsFrom(state: ChannelState): readonly ChannelState[] {
	return VALID_CHANNEL_TRANSITIONS[state];
}

/** Whether the machine connects `from` to `to` in exactly one step. */
export function isValidChannelTransition(from: ChannelState, to: ChannelState): boolean {
	return (VALID_CHANNEL_TRANSITIONS[from] as readonly ChannelState[]).includes(to);
}

/**
 * Guard for guard-then-execute: call before mutating the stored state, never after.
 *
 * @throws {InvalidChannelTransitionError} when the edge does not exist.
 */
export function assertChannelTransition(from: ChannelState, to: ChannelState): void {
	if (!isValidChannelTransition(from, to)) {
		throw new InvalidChannelTransitionError(from, to);
	}
}

/** `destroyed` only — the single state with no outgoing edges. */
export function isTerminalChannelState(state: ChannelState): boolean {
	return VALID_CHANNEL_TRANSITIONS[state].length === 0;
}

/** `hangup`, `reporting` or `destroyed`: teardown has begun and the leg can no longer be routed. */
export function isTeardownChannelState(state: ChannelState): boolean {
	return CHANNEL_TEARDOWN_SET.has(state);
}

/** The complement of {@link isTeardownChannelState}: the leg is still usable by the engine. */
export function isLiveChannelState(state: ChannelState): boolean {
	return !CHANNEL_TEARDOWN_SET.has(state);
}
