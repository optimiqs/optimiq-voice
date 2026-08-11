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
import type { MidCallFeatureState } from "./mid-call-features";
import type { ParkState } from "./park";
import type { TransferState } from "./transfer";

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

/**
 * A transfer was moved along an edge the machine does not have — completing one that was already
 * cancelled, or succeeding without first committing to the join.
 */
export class InvalidTransferTransitionError extends TelephonyError {
	readonly from: TransferState;
	readonly to: TransferState;

	constructor(from: TransferState, to: TransferState) {
		super(`Invalid transfer state transition: "${from}" -> "${to}"`);
		this.from = from;
		this.to = to;
	}
}

/**
 * A parked call was moved along a non-existent edge — retrieving one that has already timed out,
 * which is exactly the race two extensions dialling one slot produce.
 */
export class InvalidParkTransitionError extends TelephonyError {
	readonly from: ParkState;
	readonly to: ParkState;

	constructor(from: ParkState, to: ParkState) {
		super(`Invalid park state transition: "${from}" -> "${to}"`);
		this.from = from;
		this.to = to;
	}
}

/**
 * A mid-call feature-code capture was moved along an edge the machine does not have — firing an
 * action straight out of `idle`, or starting a second capture while the first one is still running.
 *
 * Always an engine bug rather than user input: the machine's own entry points refuse every digit
 * sequence a party can physically produce, so reaching this means a caller drove the machine
 * directly and skipped a stage.
 */
export class InvalidMidCallFeatureTransitionError extends TelephonyError {
	readonly from: MidCallFeatureState;
	readonly to: MidCallFeatureState;

	constructor(from: MidCallFeatureState, to: MidCallFeatureState) {
		super(`Invalid mid-call feature state transition: "${from}" -> "${to}"`);
		this.from = from;
		this.to = to;
	}
}
