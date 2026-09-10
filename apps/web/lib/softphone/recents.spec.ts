import { describe, expect, it } from "bun:test";
import { recentCalls } from "./recents";
import type { CallLegRow } from "../cdr/contracts";

/**
 * Recents, built from the CDR the platform already writes.
 *
 * The assertion that matters is the collapse. One answered two-party call writes several
 * `call_legs` — the A-leg, the answered B-leg, and one per unanswered fan-out target — so a
 * recents list rendered straight from legs shows the same colleague three times for one call, two
 * of them as missed.
 */
function leg(overrides: Partial<CallLegRow> = {}): CallLegRow {
	return {
		id: "leg-1",
		callId: "call-1",
		leg: "a",
		originatingLegId: null,
		bridgeLegId: null,
		direction: "internal",
		fromNumber: "2001",
		fromName: null,
		toNumber: "2002",
		destinationType: "extension",
		destinationRef: null,
		startedAt: "2026-09-09T10:00:00.000Z",
		answeredAt: "2026-09-09T10:00:02.000Z",
		endedAt: "2026-09-09T10:01:00.000Z",
		durationMs: 60_000,
		billsecMs: 58_000,
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		hangupSide: "caller",
		disposition: "answered",
		recordingKey: null,
		transcriptionStatus: "none",
		...overrides,
	} as CallLegRow;
}

describe("recentCalls", () => {
	it("collapses every leg of one call into a single entry", () => {
		const recents = recentCalls(
			[leg({ id: "a" }), leg({ id: "b", leg: "b" }), leg({ id: "c", leg: "b", answeredAt: null })],
			"2001",
		);
		expect(recents).toHaveLength(1);
		expect(recents[0]?.number).toBe("2002");
		expect(recents[0]?.id).toBe("a");
	});

	it("names the direction from this extension's point of view", () => {
		const [placed] = recentCalls([leg({ fromNumber: "2001", toNumber: "2002" })], "2001");
		const [taken] = recentCalls(
			[leg({ fromNumber: "2002", toNumber: "2001", fromName: "Ops" })],
			"2001",
		);
		expect(placed?.direction).toBe("out");
		expect(taken?.direction).toBe("in");
		expect(taken?.name).toBe("Ops");
		expect(taken?.number).toBe("2002");
	});

	it("lets a later answered leg upgrade a missed entry, never the reverse", () => {
		const missedFirst = recentCalls(
			[leg({ id: "a", answeredAt: null }), leg({ id: "b", leg: "b" })],
			"2001",
		);
		expect(missedFirst[0]?.answered).toBe(true);

		const answeredFirst = recentCalls(
			[leg({ id: "a" }), leg({ id: "b", leg: "b", answeredAt: null })],
			"2001",
		);
		expect(answeredFirst[0]?.answered).toBe(true);
	});

	it("keeps the API's newest-first order rather than re-sorting a page", () => {
		const recents = recentCalls(
			[
				leg({ id: "a", toNumber: "2002", startedAt: "2026-09-09T10:00:00.000Z" }),
				leg({ id: "b", toNumber: "2003", startedAt: "2026-09-09T09:00:00.000Z" }),
			],
			"2001",
		);
		expect(recents.map((entry) => entry.number)).toEqual(["2002", "2003"]);
	});

	it("drops a leg neither end of which is this extension", () => {
		// `?extension=` matches either side, so a bridged or supervised leg can legitimately arrive.
		expect(recentCalls([leg({ fromNumber: "3001", toNumber: "3002" })], "2001")).toEqual([]);
	});

	it("honours the limit", () => {
		const rows = Array.from({ length: 12 }, (_unused, index) =>
			leg({ id: `leg-${index}`, toNumber: `20${index}` }),
		);
		expect(recentCalls(rows, "2001", 8)).toHaveLength(8);
	});
});
