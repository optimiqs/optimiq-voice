/**
 * Domain errors raised by the telephony invariants.
 *
 * Per the oikos naming convention (`plans/reference/oikos-conventions.md` §3) packages raise
 * `…Error`; apps translate them into Effect `…Failure` / HTTP `…Exception` at their own seam.
 * Nothing here knows about NestJS, Effect or HTTP — this package is pure domain.
 */

import type { BridgeState } from "./bridge";
import type { CallState } from "./call-state";
import type { ChannelState } from "./channel-state";

/** Base class so a consumer can catch every telephony invariant violation with one `instanceof`. */
export class TelephonyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * A channel was asked to move between two states the FreeSWITCH-derived machine does not connect.
 *
 * This is always a bug in the engine (or a stale event applied out of order), never user input —
 * the caller must not translate it into a 4xx.
 */
export class InvalidChannelTransitionError extends TelephonyError {
	readonly from: ChannelState;
	readonly to: ChannelState;

	constructor(from: ChannelState, to: ChannelState) {
		super(`Invalid channel state transition: "${from}" -> "${to}"`);
		this.from = from;
		this.to = to;
	}
}

/** A user-visible call state (the value BLF subscribers see) was moved along a non-existent edge. */
export class InvalidCallStateTransitionError extends TelephonyError {
	readonly from: CallState;
	readonly to: CallState;

	constructor(from: CallState, to: CallState) {
		super(`Invalid call state transition: "${from}" -> "${to}"`);
		this.from = from;
		this.to = to;
	}
}

/** A bridge lifecycle transition that would, for example, re-bridge an already torn-down bridge. */
export class InvalidBridgeTransitionError extends TelephonyError {
	readonly from: BridgeState;
	readonly to: BridgeState;

	constructor(from: BridgeState, to: BridgeState) {
		super(`Invalid bridge state transition: "${from}" -> "${to}"`);
		this.from = from;
		this.to = to;
	}
}
