import { describe, expect, it } from "bun:test";
import {
	IDLE_TRANSFER,
	isTransferring,
	transferReducer,
	type TransferEvent,
	type TransferState,
} from "./transfer";

/**
 * The transfer machine, driven the way the adapter drives it.
 *
 * The assertions worth having are the guards: the adapter's events are asynchronous, so a late
 * `CONSULT_CONFIRMED` for a cancelled consultation and a double-clicked transfer button are both
 * ordinary. Either one advancing the machine would put the panel in a state the SIP dialogs are
 * not in — a "Complete transfer" button over a dialog that no longer exists.
 */
function fold(
	events: readonly TransferEvent[],
	from: TransferState = IDLE_TRANSFER,
): TransferState {
	return events.reduce(transferReducer, from);
}

describe("blind transfer", () => {
	it("goes straight to referring and holds the target", () => {
		const state = fold([{ type: "TRANSFER_REQUESTED", mode: "blind", target: "2003" }]);
		expect(state.status).toBe("referring");
		expect(state.mode).toBe("blind");
		expect(state.target).toBe("2003");
	});

	it("reports a refused REFER with the reason, and stops there", () => {
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "blind", target: "2003" },
			{ type: "TRANSFER_FAILED", reason: "The transfer to 2003 was refused." },
		]);
		expect(state.status).toBe("failed");
		expect(state.error).toBe("The transfer to 2003 was refused.");
		expect(isTransferring(state)).toBe(false);
	});
});

describe("attended transfer", () => {
	it("walks consult-ringing → consult-active → completing", () => {
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "attended", target: "2003" },
			{ type: "CONSULT_CONFIRMED" },
			{ type: "TRANSFER_COMPLETING" },
		]);
		expect(state.status).toBe("completing");
		expect(state.mode).toBe("attended");
	});

	it("cannot be completed before the consultation is answered", () => {
		// The REFER carries `Replaces: <the consultation dialog>`. There is no dialog to name until
		// the consultation is confirmed, so completing early would send a header pointing at nothing.
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "attended", target: "2003" },
			{ type: "TRANSFER_COMPLETING" },
		]);
		expect(state.status).toBe("consult-ringing");
	});

	it("returns to idle when the user backs out of the consultation", () => {
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "attended", target: "2003" },
			{ type: "CONSULT_CONFIRMED" },
			{ type: "TRANSFER_CANCELLED" },
		]);
		expect(state).toEqual(IDLE_TRANSFER);
	});
});

describe("the guards", () => {
	it("refuses a second request while one is in flight", () => {
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "attended", target: "2003" },
			{ type: "TRANSFER_REQUESTED", mode: "blind", target: "2004" },
		]);
		expect(state.status).toBe("consult-ringing");
		expect(state.target).toBe("2003");
	});

	it("allows a retry after a failure", () => {
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "blind", target: "2003" },
			{ type: "TRANSFER_FAILED", reason: "nope" },
			{ type: "TRANSFER_REQUESTED", mode: "blind", target: "2004" },
		]);
		expect(state.status).toBe("referring");
		expect(state.target).toBe("2004");
		expect(state.error).toBeNull();
	});

	it("ignores a late confirmation for a consultation that was cancelled", () => {
		const state = fold([
			{ type: "TRANSFER_REQUESTED", mode: "attended", target: "2003" },
			{ type: "TRANSFER_CANCELLED" },
			{ type: "CONSULT_CONFIRMED" },
		]);
		expect(state).toEqual(IDLE_TRANSFER);
	});

	it("ignores a failure when nothing was being transferred", () => {
		expect(fold([{ type: "TRANSFER_FAILED", reason: "stray" }])).toEqual(IDLE_TRANSFER);
	});
});
