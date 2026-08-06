import { describe, expect, it } from "bun:test";
import {
	buildCallTree,
	counterparty,
	destinationTypeLabel,
	dispositionLabel,
	dispositionTone,
	flattenCallTree,
	formatBillsec,
	formatBytes,
	formatDuration,
	hangupCauseLabel,
	hangupCauseTone,
	recordingsForLeg,
} from "./format";
import type { CallLegRow, RecordingRow } from "./contracts";

function leg(overrides: Partial<CallLegRow> & { id: string }): CallLegRow {
	return {
		callId: "call-1",
		leg: "b",
		originatingLegId: null,
		bridgeLegId: null,
		direction: "inbound",
		fromNumber: "+12125550100",
		fromName: null,
		toNumber: "1001",
		destinationType: "extension",
		destinationRef: null,
		startedAt: "2026-08-05T10:00:00.000Z",
		answeredAt: null,
		endedAt: null,
		durationMs: 0,
		billsecMs: 0,
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		hangupSide: null,
		disposition: "answered",
		recordingKey: null,
		transcriptionStatus: "none",
		...overrides,
	};
}

describe("formatDuration", () => {
	it("writes mm:ss under an hour and h:mm:ss over it", () => {
		expect(formatDuration(0)).toBe("00:00");
		expect(formatDuration(12_000)).toBe("00:12");
		expect(formatDuration(271_000)).toBe("04:31");
		expect(formatDuration(3_661_000)).toBe("1:01:01");
	});

	it("rounds a sub-second leg down, never up", () => {
		// A leg that lasted 400ms did not last a second, and reporting it as one is how "why does
		// this show 1s of billing" tickets start.
		expect(formatDuration(400)).toBe("00:00");
		expect(formatDuration(1_999)).toBe("00:01");
	});
});

describe("formatBillsec", () => {
	it("distinguishes not-billed from billed-for-zero-seconds", () => {
		expect(formatBillsec(0)).toBe("—");
		expect(formatBillsec(400)).toBe("00:00");
	});
});

describe("formatBytes", () => {
	it("uses binary units and an em dash for nothing", () => {
		expect(formatBytes(0)).toBe("—");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MiB");
	});
});

describe("outcome tones", () => {
	it("does not paint voicemail as a successful answer", () => {
		expect(dispositionTone("answered")).toBe("success");
		expect(dispositionTone("voicemail")).toBe("accent");
	});

	it("separates an ordinary non-answer from a failure", () => {
		expect(dispositionTone("no-answer")).toBe("warning");
		expect(dispositionTone("failed")).toBe("danger");
	});

	it("labels no-answer as a sentence rather than an enum", () => {
		expect(dispositionLabel("no-answer")).toBe("No answer");
		expect(dispositionLabel("busy")).toBe("Busy");
	});
});

describe("hangup causes", () => {
	it("treats normal clearing as unremarkable and a carrier failure as not", () => {
		expect(hangupCauseTone("NORMAL_CLEARING")).toBe("neutral");
		expect(hangupCauseTone("USER_BUSY")).toBe("warning");
		expect(hangupCauseTone("GATEWAY_DOWN")).toBe("danger");
	});

	it("writes the taxonomy for people", () => {
		expect(hangupCauseLabel("NO_USER_RESPONSE")).toBe("No user response");
	});
});

describe("destinationTypeLabel", () => {
	it("reads the same whichever vocabulary the value came from", () => {
		expect(destinationTypeLabel("ring_group")).toBe("Ring group");
		expect(destinationTypeLabel("time-condition")).toBe("Time condition");
	});
});

describe("counterparty", () => {
	it("is the caller inbound and the callee outbound", () => {
		expect(counterparty(leg({ id: "1", direction: "inbound" }))).toBe("+12125550100");
		expect(counterparty(leg({ id: "1", direction: "outbound" }))).toBe("1001");
	});
});

describe("buildCallTree", () => {
	it("hangs every B-leg off the leg that dialled it", () => {
		const legs = [
			leg({ id: "a", leg: "a" }),
			leg({ id: "b1", originatingLegId: "a" }),
			leg({ id: "b2", originatingLegId: "a" }),
			leg({ id: "b3", originatingLegId: "b1" }),
		];

		const flat = flattenCallTree(buildCallTree(legs));

		expect(flat.map((node) => node.leg.id)).toEqual(["a", "b1", "b3", "b2"]);
		expect(flat.map((node) => node.depth)).toEqual([0, 1, 2, 1]);
	});

	it("keeps a leg whose parent is not in the set instead of dropping it", () => {
		// The parent's partition may have been retired, or the range may start after it. Showing
		// four of five legs is a bug report; showing five with one unattached is the truth.
		const legs = [leg({ id: "a", leg: "a" }), leg({ id: "orphan", originatingLegId: "gone" })];

		const flat = flattenCallTree(buildCallTree(legs));

		expect(flat.map((node) => node.leg.id).sort()).toEqual(["a", "orphan"]);
		expect(flat.every((node) => node.depth === 0)).toBe(true);
	});

	it("does not loop on a leg that names itself", () => {
		const legs = [leg({ id: "a", leg: "a", originatingLegId: "a" })];

		expect(flattenCallTree(buildCallTree(legs))).toHaveLength(1);
	});

	it("survives a cycle between two legs", () => {
		const legs = [
			leg({ id: "x", originatingLegId: "y" }),
			leg({ id: "y", originatingLegId: "x" }),
		];

		// Unreachable in real data (a leg is originated before it can originate), but a corrupted
		// row must not hang the browser.
		expect(flattenCallTree(buildCallTree(legs)).length).toBeLessThanOrEqual(2);
	});
});

describe("recordingsForLeg", () => {
	it("selects only the media of the leg asked for", () => {
		const recordings: RecordingRow[] = [
			{
				id: "r1",
				callId: "call-1",
				legId: "a",
				kind: "call",
				objectKey: "org/call/r1.wav",
				durationMs: 1000,
				sizeBytes: 100,
				retentionUntil: null,
				deletedAt: null,
				createdAt: "2026-08-05T10:00:00.000Z",
			},
			{
				id: "r2",
				callId: "call-1",
				legId: "b1",
				kind: "call",
				objectKey: "org/call/r2.wav",
				durationMs: 1000,
				sizeBytes: 100,
				retentionUntil: null,
				deletedAt: null,
				createdAt: "2026-08-05T10:00:00.000Z",
			},
		];

		expect(recordingsForLeg(recordings, "a").map((entry) => entry.id)).toEqual(["r1"]);
	});
});
