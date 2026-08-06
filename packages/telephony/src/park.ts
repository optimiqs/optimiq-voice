/**
 * Park state machine and orbit-slot arithmetic.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §3 ("park lots, orbit slots,
 * a timeout that returns the call to the parker"). A parked call is the one destination in the
 * system with no second party: the caller is held by the switch itself, hearing music, addressed
 * only by the number of the slot they are sitting in.
 *
 * ## Why the slot arithmetic is here and not in the engine
 *
 * "Which slot does this call get?" is a pure function of the lot's range, the slots already taken
 * and the slot the parker asked for. Putting it in the domain package means the engine's registry
 * is a map plus a lock, the compiler can validate a lot's range against the same helpers, and the
 * awkward cases — a full lot, a requested slot that is taken, a range of exactly one — are
 * testable without a channel.
 *
 * ## Why a state machine for something so small
 *
 * Because the interesting part of parking is the three ways it ENDS, and they are not
 * interchangeable. A call retrieved from a slot is a completed transfer; a call that timed out is a
 * call the parker forgot and must be rung back about; a call that hung up in the lot is an
 * abandoned call. All three produce the same silence on the wire and completely different rows in a
 * report, so the engine must commit to one of them explicitly.
 *
 * Per the oikos convention (`plans/reference/oikos-conventions.md` §4) the machine is a
 * `VALID_TRANSITIONS` const with terminal states of `[]`, and every mutation is guard-then-execute:
 * `assertParkTransition` before the write, never after.
 */

import { InvalidParkTransitionError } from "./errors";

/**
 * Every stage a parked call can occupy, in canonical order.
 *
 * - `parking` — a slot has been claimed and the caller is being moved into it. Separate from
 *   `parked` because the claim happens before the media move, and a caller who hangs up in between
 *   must release the slot rather than leave it occupied by nobody.
 * - `parked` — the caller is in the lot, hearing music on hold, addressable by slot number.
 * - `retrieving` — somebody dialled the slot and is being joined to the caller. Separate from
 *   `retrieved` so that two extensions dialling the same slot at the same instant cannot both win.
 * - `retrieved` — terminal. The caller is bridged to whoever collected them.
 * - `timed-out` — terminal. The lot's timeout elapsed; the call is returned to the parker.
 * - `abandoned` — terminal. The caller hung up while parked. Nobody is left to retrieve.
 * - `failed` — terminal. The park could not be carried out at all.
 */
export const PARK_STATES = [
	"parking",
	"parked",
	"retrieving",
	"retrieved",
	"timed-out",
	"abandoned",
	"failed",
] as const;

export type ParkState = (typeof PARK_STATES)[number];

/** The stage every park starts in. */
export const INITIAL_PARK_STATE = "parking" satisfies ParkState;

/** The four stages with no outgoing edges. */
export const PARK_TERMINAL_STATES = [
	"retrieved",
	"timed-out",
	"abandoned",
	"failed",
] as const satisfies readonly ParkState[];

/**
 * Adjacency of the machine.
 *
 * Invariants pinned by `park.spec.ts`:
 * 1. `retrieved`, `timed-out`, `abandoned` and `failed` are terminal (`[]`).
 * 2. `retrieved` is reachable ONLY from `retrieving` — the claim is what decides the race between
 *    two extensions dialling one slot, so a retrieval that skipped it would mean both won.
 * 3. `abandoned` is reachable from every live stage: a caller can hang up at any moment, including
 *    while somebody is walking towards the phone to collect them.
 * 4. `retrieving` can fall back to `parked`. A retrieval that fails must put the call back in its
 *    slot rather than strand it, which is the difference between a busy extension and a lost call.
 * 5. No state lists itself, and every state is reachable from `parking`.
 */
export const VALID_PARK_TRANSITIONS = {
	parking: ["parked", "abandoned", "failed"],
	parked: ["retrieving", "timed-out", "abandoned"],
	retrieving: ["retrieved", "parked", "abandoned", "failed"],
	retrieved: [],
	"timed-out": [],
	abandoned: [],
	failed: [],
} as const satisfies Record<ParkState, readonly ParkState[]>;

/**
 * How a park ended, as the `call.unparked` event reports it.
 *
 * The three live outcomes of the machine, flattened for the wire. `failed` is absent on purpose: a
 * park that never happened has nothing to un-park, and reporting one would put a phantom row in
 * every park report.
 */
export const PARK_END_REASONS = ["retrieved", "timeout", "abandoned"] as const;

export type ParkEndReason = (typeof PARK_END_REASONS)[number];

const PARK_STATE_SET = new Set<string>(PARK_STATES);
const PARK_TERMINAL_SET = new Set<string>(PARK_TERMINAL_STATES);
const PARK_END_REASON_SET = new Set<string>(PARK_END_REASONS);

/** Type guard for a stage arriving from an event or a KV snapshot. */
export function isParkState(value: string): value is ParkState {
	return PARK_STATE_SET.has(value);
}

/** Type guard for an end reason arriving from the wire. */
export function isParkEndReason(value: string): value is ParkEndReason {
	return PARK_END_REASON_SET.has(value);
}

/** The stages reachable in one step. Never `undefined`; a terminal stage returns `[]`. */
export function parkTransitionsFrom(state: ParkState): readonly ParkState[] {
	return VALID_PARK_TRANSITIONS[state];
}

/** Whether the machine connects `from` to `to` in exactly one step. */
export function isValidParkTransition(from: ParkState, to: ParkState): boolean {
	return (VALID_PARK_TRANSITIONS[from] as readonly ParkState[]).includes(to);
}

/**
 * Guard for guard-then-execute: call before mutating the stored stage, never after.
 *
 * @throws {InvalidParkTransitionError} when the edge does not exist.
 */
export function assertParkTransition(from: ParkState, to: ParkState): void {
	if (!isValidParkTransition(from, to)) {
		throw new InvalidParkTransitionError(from, to);
	}
}

/** Whether the park is over, whichever way it went. */
export function isTerminalParkState(state: ParkState): boolean {
	return PARK_TERMINAL_SET.has(state);
}

/** The end reason a terminal stage maps to, or `undefined` for `failed` and the live stages. */
export function parkEndReasonFor(state: ParkState): ParkEndReason | undefined {
	switch (state) {
		case "retrieved":
			return "retrieved";
		case "timed-out":
			return "timeout";
		case "abandoned":
			return "abandoned";
		default:
			return undefined;
	}
}

/** A lot's inclusive orbit range, exactly as the compiled `park` plan node carries it. */
export interface ParkSlotRangeBounds {
	readonly slotStart: number;
	readonly slotEnd: number;
}

/** Whether the range is usable at all: whole numbers, start no later than end. */
export function isUsableParkSlotRange(range: ParkSlotRangeBounds): boolean {
	return (
		Number.isSafeInteger(range.slotStart) &&
		Number.isSafeInteger(range.slotEnd) &&
		range.slotStart <= range.slotEnd
	);
}

/** How many orbits the lot has. Zero for an unusable range, never negative. */
export function parkSlotCapacity(range: ParkSlotRangeBounds): number {
	return isUsableParkSlotRange(range) ? range.slotEnd - range.slotStart + 1 : 0;
}

/** Whether `slot` is one of the lot's orbits. */
export function isParkSlotInRange(range: ParkSlotRangeBounds, slot: number): boolean {
	return isUsableParkSlotRange(range) && slot >= range.slotStart && slot <= range.slotEnd;
}

/**
 * Parses a dialled orbit.
 *
 * Strict on purpose: `"4001"` is a slot and `"4001a"`, `" 4001"` and `"+4001"` are not. A park lot
 * is addressed by digits a phone sent, and accepting anything looser here would let a mistyped
 * extension retrieve somebody else's call.
 */
export function parseParkSlot(value: string): number | undefined {
	if (!/^[0-9]+$/u.test(value)) {
		return undefined;
	}
	const slot = Number.parseInt(value, 10);
	return Number.isSafeInteger(slot) ? slot : undefined;
}

/**
 * The orbit a call about to be parked should take.
 *
 * `preferred` is what the parker asked for (`*5401`); it wins when it is in range and free, and is
 * REFUSED rather than silently reassigned when it is taken — somebody who parks a call in slot 401
 * and announces "it's on 401" must not have it quietly land on 402.
 *
 * With no preference the lowest free orbit wins, which is what makes a lot's slots stay dense and
 * short to announce over a PA system.
 *
 * @returns the slot, or `undefined` when the lot is full, the range is unusable, or the requested
 * slot is out of range or occupied.
 */
export function nextFreeParkSlot(
	range: ParkSlotRangeBounds,
	occupied: Iterable<number>,
	preferred?: number,
): number | undefined {
	if (!isUsableParkSlotRange(range)) {
		return undefined;
	}
	const taken = new Set<number>(occupied);
	if (preferred !== undefined) {
		return isParkSlotInRange(range, preferred) && !taken.has(preferred) ? preferred : undefined;
	}
	for (let slot = range.slotStart; slot <= range.slotEnd; slot += 1) {
		if (!taken.has(slot)) {
			return slot;
		}
	}
	return undefined;
}
