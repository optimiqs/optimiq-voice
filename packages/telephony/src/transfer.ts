/**
 * Transfer state machine — one call handed from one party to another.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §3 ("blind transfer resets
 * the leg into a new context; attended transfer holds the current party, originates a consultation
 * leg and completes on the transferor's hangup") and §6 (`BLIND_TRANSFER` 800 /
 * `ATTENDED_TRANSFER` 801 as the causes a completed transfer leaves behind).
 *
 * ## Why one machine for both kinds
 *
 * A blind transfer is an attended transfer that skips the middle. Both begin with a request, both
 * end by joining two legs that were never joined before, and both must be able to fail at any point
 * without leaving a caller listening to nothing. Modelling them separately would produce two
 * `completed` states, two failure paths, and two places to remember that the transferor's leg is
 * hung up with a cause that keeps a transfer out of the "failed call" reports.
 *
 * So the difference is expressed in the PATH taken through one table: blind goes
 * `initiated → completing → completed`, attended goes
 * `initiated → held → consulting → completing → completed`, and both reach `cancelled` or `failed`
 * from wherever they were.
 *
 * ## Three parties, named once
 *
 * A transfer always involves three legs and the names are used verbatim everywhere in the engine:
 *
 * - **transferor** — the party that asked for the transfer. They talk to the target during an
 *   attended consultation and are hung up with {@link hangupCauseForTransfer} when it completes.
 * - **transferee** — the party being handed over. They are held (music on hold) for the duration of
 *   an attended consultation and hear nothing of it.
 * - **target** — where the transferee ends up.
 *
 * Per the oikos convention (`plans/reference/oikos-conventions.md` §4) the machine is a
 * `VALID_TRANSITIONS` const with terminal states of `[]`, and every mutation is guard-then-execute:
 * `assertTransferTransition` before the write, never after.
 */

import { InvalidTransferTransitionError } from "./errors";
import type { HangupCause } from "./hangup-causes";
import type { TransferKind } from "./verbs";

/**
 * Every stage a transfer can occupy, in canonical order.
 *
 * - `initiated` — the request has been accepted and nothing has moved yet. Both kinds start here.
 * - `held` — the transferee is out of the bridge and hearing music on hold. Attended only: a blind
 *   transfer never holds anybody, because there is nobody to hold them for.
 * - `consulting` — the consultation leg exists and the transferor is talking to the target.
 *   Attended only.
 * - `completing` — the two surviving legs are being joined. Entered the instant the decision is
 *   irreversible, so a failure from here is a failure of the JOIN and not of the decision.
 * - `completed` — terminal. The transferee and the target are bridged.
 * - `cancelled` — terminal. The transferor abandoned the transfer and the transferee was returned
 *   to them. Reachable from every pre-`completing` stage, because a caller may hang up at any of
 *   them, and cancelling is what puts the original call back.
 * - `failed` — terminal. The transfer could not be carried out. The transferee goes to the
 *   fallback destination, or back to the transferor when there is none.
 */
export const TRANSFER_STATES = [
	"initiated",
	"held",
	"consulting",
	"completing",
	"completed",
	"cancelled",
	"failed",
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];

/** The stage every transfer starts in. */
export const INITIAL_TRANSFER_STATE = "initiated" satisfies TransferState;

/** The three stages with no outgoing edges. A transfer that reaches one is over. */
export const TRANSFER_TERMINAL_STATES = [
	"completed",
	"cancelled",
	"failed",
] as const satisfies readonly TransferState[];

/**
 * Adjacency of the machine.
 *
 * Invariants pinned by `transfer.spec.ts`:
 * 1. `completed`, `cancelled` and `failed` are terminal (`[]`).
 * 2. `completed` is reachable ONLY from `completing` — a transfer cannot succeed without first
 *    committing to the join, which is what makes "was this call transferred?" answerable from the
 *    event stream rather than inferred from two hangups that happened to be close together.
 * 3. Every non-terminal stage can reach `failed`, and every stage before `completing` can reach
 *    `cancelled`. Once the join has been committed there is nothing left to cancel back to.
 * 4. No state lists itself.
 * 5. Every state is reachable from `initiated`.
 */
export const VALID_TRANSFER_TRANSITIONS = {
	initiated: ["held", "consulting", "completing", "cancelled", "failed"],
	held: ["consulting", "completing", "cancelled", "failed"],
	consulting: ["held", "completing", "cancelled", "failed"],
	completing: ["completed", "failed"],
	completed: [],
	cancelled: [],
	failed: [],
} as const satisfies Record<TransferState, readonly TransferState[]>;

const TRANSFER_STATE_SET = new Set<string>(TRANSFER_STATES);
const TRANSFER_TERMINAL_SET = new Set<string>(TRANSFER_TERMINAL_STATES);

/** Type guard for a stage arriving from an event, a KV snapshot or a session-protocol message. */
export function isTransferState(value: string): value is TransferState {
	return TRANSFER_STATE_SET.has(value);
}

/** The stages reachable in one step. Never `undefined`; a terminal stage returns `[]`. */
export function transferTransitionsFrom(state: TransferState): readonly TransferState[] {
	return VALID_TRANSFER_TRANSITIONS[state];
}

/** Whether the machine connects `from` to `to` in exactly one step. */
export function isValidTransferTransition(from: TransferState, to: TransferState): boolean {
	return (VALID_TRANSFER_TRANSITIONS[from] as readonly TransferState[]).includes(to);
}

/**
 * Guard for guard-then-execute: call before mutating the stored stage, never after.
 *
 * @throws {InvalidTransferTransitionError} when the edge does not exist.
 */
export function assertTransferTransition(from: TransferState, to: TransferState): void {
	if (!isValidTransferTransition(from, to)) {
		throw new InvalidTransferTransitionError(from, to);
	}
}

/** Whether the transfer is over, whichever way it went. */
export function isTerminalTransferState(state: TransferState): boolean {
	return TRANSFER_TERMINAL_SET.has(state);
}

/**
 * The stage a transfer of this kind enters after `initiated`.
 *
 * The one place the two kinds diverge, expressed as data rather than as a conditional at each call
 * site: a blind transfer commits immediately, an attended one holds the transferee first.
 */
export const FIRST_TRANSFER_STATE_BY_KIND = {
	blind: "completing",
	attended: "held",
} as const satisfies Record<TransferKind, TransferState>;

/**
 * The cause a completed transfer leaves on the transferor's leg.
 *
 * `NORMAL_CLEARING` would be wrong and expensively so: a transferor who hands a call off and drops
 * looks identical to a caller who hung up, and that difference is what keeps a transfer out of the
 * abandoned-call column of every report built on `call_legs.hangup_cause`.
 */
export function hangupCauseForTransfer(kind: TransferKind): HangupCause {
	return kind === "attended" ? "ATTENDED_TRANSFER" : "BLIND_TRANSFER";
}
