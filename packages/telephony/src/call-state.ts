/**
 * User-visible call states and device-state aggregation — the values that drive BLF.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §1
 * ("User-visible call states … `DOWN, DIALING, RINGING, EARLY, ACTIVE, HELD, RING_WAIT, HANGUP,
 * UNHELD`" and "Device states … `DOWN, RINGING, ACTIVE, ACTIVE_MULTI, HELD, UNHELD, HANGUP`").
 *
 * Two machines, deliberately separate:
 * - `./channel-state` is what the engine does to a leg (routing, executing, media exchange).
 * - This file is what a watcher sees. A desk phone subscribed to an extension's presence renders
 *   the {@link DeviceState}; it must never see engine internals, and it must never flicker, which
 *   is why the aggregation below is a total function with a fixed precedence order rather than a
 *   pile of ad-hoc conditions in the presence publisher.
 */

import { InvalidCallStateTransitionError } from "./errors";

/**
 * The call state of a single channel, as published on the channel-callstate event.
 *
 * - `down` — no call on this channel yet (the initial value).
 * - `dialing` — an outbound leg is being originated; nothing has come back from the far end.
 * - `ring-wait` — originated and waiting to be alerted; ringback has not started yet.
 * - `ringing` — the far end is alerting (SIP 180, no media).
 * - `early` — early media is flowing before answer (SIP 183 + SDP); audio, but not billable.
 * - `active` — answered (SIP 200 OK); the media path is up.
 * - `held` — on hold; MOH is being served from the shared stream, not a per-call file read.
 * - `unheld` — the transient state a leg passes through when hold is released, before settling
 *   back to `active`. It exists so watchers can distinguish "resumed" from "was never held".
 * - `hangup` — terminal.
 */
export const CALL_STATES = [
	"down",
	"dialing",
	"ring-wait",
	"ringing",
	"early",
	"active",
	"held",
	"unheld",
	"hangup",
] as const;

export type CallState = (typeof CALL_STATES)[number];

/** The call state a channel is published with before anything happens to it. */
export const INITIAL_CALL_STATE = "down" satisfies CallState;

/**
 * Adjacency of the user-visible machine.
 *
 * Invariants pinned by `call-state.spec.ts`:
 * 1. `hangup` is terminal (`[]`) and reachable from every other state — any leg can drop at any
 *    point, including while it is only being dialed.
 * 2. `active` is reachable from every pre-answer state; `held` is reachable only from `active`
 *    (you cannot hold a leg that was never answered).
 * 3. `unheld` is reachable only from `held`, and leads only back to `active` (or another `held`,
 *    or `hangup`) — it is a pass-through, never a resting state.
 * 4. No state lists itself.
 */
export const VALID_CALL_STATE_TRANSITIONS = {
	down: ["dialing", "ring-wait", "ringing", "early", "active", "hangup"],
	dialing: ["ring-wait", "ringing", "early", "active", "hangup"],
	"ring-wait": ["ringing", "early", "active", "hangup"],
	ringing: ["early", "active", "hangup"],
	early: ["ringing", "active", "hangup"],
	active: ["held", "hangup"],
	held: ["unheld", "hangup"],
	unheld: ["active", "held", "hangup"],
	hangup: [],
} as const satisfies Record<CallState, readonly CallState[]>;

/**
 * The aggregate state of every channel belonging to one device/extension — what a BLF subscriber
 * actually renders on a busy-lamp key.
 *
 * `active-multi` is the reason this cannot be "just pick the highest call state": a user with two
 * answered calls (one parked on a second line appearance) is materially different from a user with
 * one, and the phone renders it differently.
 */
export const DEVICE_STATES = [
	"down",
	"ringing",
	"active",
	"active-multi",
	"held",
	"unheld",
	"hangup",
] as const;

export type DeviceState = (typeof DEVICE_STATES)[number];

/** Call states that mean "the device is being alerted / is trying to reach someone, no answer yet". */
export const ALERTING_CALL_STATES = [
	"dialing",
	"ring-wait",
	"ringing",
	"early",
] as const satisfies readonly CallState[];

/** Call states that mean "there is an answered, non-held call on this channel". */
export const ON_CALL_CALL_STATES = ["active", "unheld"] as const satisfies readonly CallState[];

const CALL_STATE_SET = new Set<string>(CALL_STATES);
const DEVICE_STATE_SET = new Set<string>(DEVICE_STATES);
const ALERTING_SET = new Set<string>(ALERTING_CALL_STATES);
const ON_CALL_SET = new Set<string>(ON_CALL_CALL_STATES);

/** Type guard for a call state arriving from the wire or a KV presence snapshot. */
export function isCallState(value: string): value is CallState {
	return CALL_STATE_SET.has(value);
}

/** Type guard for a device state arriving from the wire or a KV presence snapshot. */
export function isDeviceState(value: string): value is DeviceState {
	return DEVICE_STATE_SET.has(value);
}

/** The call states reachable in one step. Never `undefined`; `hangup` returns `[]`. */
export function callStateTransitionsFrom(state: CallState): readonly CallState[] {
	return VALID_CALL_STATE_TRANSITIONS[state];
}

/** Whether the machine connects `from` to `to` in exactly one step. */
export function isValidCallStateTransition(from: CallState, to: CallState): boolean {
	return (VALID_CALL_STATE_TRANSITIONS[from] as readonly CallState[]).includes(to);
}

/**
 * Guard for guard-then-execute: call before publishing the new call state, never after.
 *
 * @throws {InvalidCallStateTransitionError} when the edge does not exist.
 */
export function assertCallStateTransition(from: CallState, to: CallState): void {
	if (!isValidCallStateTransition(from, to)) {
		throw new InvalidCallStateTransitionError(from, to);
	}
}

/** `hangup` only — the single call state with no outgoing edges. */
export function isTerminalCallState(state: CallState): boolean {
	return VALID_CALL_STATE_TRANSITIONS[state].length === 0;
}

/** Whether the state means the leg has been answered (media path up, billing clock running). */
export function isAnsweredCallState(state: CallState): boolean {
	return ON_CALL_SET.has(state) || state === "held";
}

/** Whether the state means the leg is being alerted or is chasing an answer. */
export function isAlertingCallState(state: CallState): boolean {
	return ALERTING_SET.has(state);
}

/**
 * Collapses every channel of one device into the single value a BLF subscriber renders.
 *
 * Precedence is fixed and total (`plans/reference/freeswitch-capabilities.md` §1). Evaluated in
 * order, first match wins:
 *
 * 1. No channels at all → `down`.
 * 2. Every channel has hung up → `hangup` (the edge the phone needs in order to clear the lamp;
 *    the publisher follows it with `down` once the channels are reaped).
 * 3. More than one answered, non-held channel → `active-multi`.
 * 4. Exactly one answered, non-held channel → `unheld` if that channel is mid-resume, else
 *    `active`. Answered beats held: a user with one live call and one parked call is "on a call".
 * 5. Any held channel (and nothing answered) → `held`.
 * 6. Any alerting channel (`dialing` / `ring-wait` / `ringing` / `early`) → `ringing`. Outbound
 *    dialing counts: the key must light while the user is placing a call, not only while
 *    receiving one.
 * 7. Otherwise (only `down` and already-reaped channels remain) → `down`.
 *
 * Total over its input by construction — an empty array is a legitimate call (a device with no
 * channels is `down`), so callers never pre-check.
 */
export function aggregateDeviceState(callStates: readonly CallState[]): DeviceState {
	if (callStates.length === 0) {
		return "down";
	}

	let alerting = 0;
	let onCall = 0;
	let resuming = 0;
	let held = 0;
	let hungUp = 0;

	for (const state of callStates) {
		if (state === "hangup") {
			hungUp += 1;
		} else if (state === "held") {
			held += 1;
		} else if (state === "unheld") {
			onCall += 1;
			resuming += 1;
		} else if (state === "active") {
			onCall += 1;
		} else if (ALERTING_SET.has(state)) {
			alerting += 1;
		}
	}

	if (hungUp === callStates.length) {
		return "hangup";
	}
	if (onCall > 1) {
		return "active-multi";
	}
	if (onCall === 1) {
		return resuming === 1 ? "unheld" : "active";
	}
	if (held > 0) {
		return "held";
	}
	if (alerting > 0) {
		return "ringing";
	}

	return "down";
}
