/**
 * The transfer state machine — pure, and the part worth testing.
 *
 * Transfer is the one softphone operation with a shape the single-call reducer cannot hold: an
 * ATTENDED transfer means two SIP dialogs at once (the held party, and the consultation), and the
 * user is allowed to abandon the consultation and go back to the first. So it is its own small
 * machine, folded into {@link SoftphoneState} by `call-state.ts` and driven by the same events.
 *
 * ## The two transfers, and what each is on the wire
 *
 * - **Blind**: `REFER` with the target in `Refer-To`, sent on the established dialog. The transferor
 *   learns nothing about whether the transferee ever answered — the `NOTIFY` says the REFER was
 *   accepted, not that the call succeeded — so `referring` is a state that ends in the call ending,
 *   never in a "transferred, and they picked up" the protocol cannot supply.
 * - **Attended**: hold the first call, place a second one, talk, then `REFER` the FIRST dialog to
 *   the second with a `Replaces` header naming it. `consult-ringing` → `consult-active` is the
 *   second call's own progress; `completing` is the REFER.
 *
 * `apps/sipd` implements the receiving half of both (`OnRefer`, `Replaces` honoured), which is why
 * these are reachable at all. An in-dialog REFER is authorised there by membership of the dialog
 * rather than by digest: JsSIP builds an in-dialog request's `From` from the dialog's local URI
 * (RFC 3261 §12.2), which on a session this side ANSWERED is not an identity anything can
 * authenticate.
 */

export type TransferMode = "blind" | "attended";

/**
 * Where a transfer is.
 *
 * `failed` is terminal and carries why; every other state is either quiescent (`idle`) or has a
 * request outstanding. There is deliberately no `succeeded`: a successful transfer ends the call,
 * and the ended card is the honest place for that.
 */
export type TransferStatus =
	| "idle"
	| "referring"
	| "consult-ringing"
	| "consult-active"
	| "completing"
	| "failed";

export interface TransferState {
	readonly status: TransferStatus;
	readonly mode: TransferMode | null;
	/** Who the call is being transferred to. Held so the UI can name them in every state. */
	readonly target: string | null;
	/** Why the last attempt failed, for the panel to show. `null` unless `status` is `failed`. */
	readonly error: string | null;
}

export const IDLE_TRANSFER: TransferState = {
	status: "idle",
	mode: null,
	target: null,
	error: null,
};

export type TransferEvent =
	| { readonly type: "TRANSFER_REQUESTED"; readonly mode: TransferMode; readonly target: string }
	| { readonly type: "CONSULT_CONFIRMED" }
	| { readonly type: "TRANSFER_COMPLETING" }
	| { readonly type: "TRANSFER_FAILED"; readonly reason: string }
	/** The user backed out: the consultation is hung up and the first call comes off hold. */
	| { readonly type: "TRANSFER_CANCELLED" };

/** Whether a transfer is mid-flight — the window in which a second request must be refused. */
export function isTransferring(state: TransferState): boolean {
	return state.status !== "idle" && state.status !== "failed";
}

/**
 * The reducer.
 *
 * Every guard here exists because the adapter's events are asynchronous and can arrive late: a
 * `CONSULT_CONFIRMED` for a consultation the user already cancelled, or a second
 * `TRANSFER_REQUESTED` from a double-clicked button. Advancing on either would put the panel in a
 * state the SIP dialogs are not in, which is how a user ends up pressing "Complete transfer" on a
 * consultation that no longer exists.
 */
export function transferReducer(state: TransferState, event: TransferEvent): TransferState {
	switch (event.type) {
		case "TRANSFER_REQUESTED":
			if (isTransferring(state)) {
				return state;
			}
			return {
				status: event.mode === "blind" ? "referring" : "consult-ringing",
				mode: event.mode,
				target: event.target,
				error: null,
			};

		case "CONSULT_CONFIRMED":
			if (state.status !== "consult-ringing") {
				return state;
			}
			return { ...state, status: "consult-active" };

		case "TRANSFER_COMPLETING":
			if (state.status !== "consult-active") {
				return state;
			}
			return { ...state, status: "completing" };

		case "TRANSFER_FAILED":
			if (state.status === "idle") {
				return state;
			}
			return { ...state, status: "failed", error: event.reason };

		case "TRANSFER_CANCELLED":
			return IDLE_TRANSFER;

		default: {
			// Exhaustiveness: a new event type that is not handled fails the type-check here.
			const _never: never = event;
			return state;
		}
	}
}
