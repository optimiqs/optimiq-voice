import { describe, expect, it } from "bun:test";
import { agentStatsParams, callVolumeParams, MAX_WRAP_UP_SECONDS } from "./client";
import {
	answerRatePct,
	busiestBucket,
	destinationSeriesKeys,
	destinationTotals,
	emptyAgentStats,
	hasUsableWrapUp,
	talkSharePct,
	volumeTotals,
	MIN_WRAP_UP_SAMPLES,
} from "./reporting";
import type { AgentStatsRow, CallVolumeRow } from "./contracts";

/**
 * The reports' arithmetic.
 *
 * Every test here is about a rendering that would be plausible and wrong. A report is read once and
 * acted on, often by somebody about to have a conversation with a person, so the failure mode is not
 * a broken page — it is a confident number with nothing behind it.
 */

function bucket(overrides: Partial<CallVolumeRow> = {}): CallVolumeRow {
	return {
		bucket: "2026-08-05T09:00:00.000Z",
		total: 0,
		inbound: 0,
		outbound: 0,
		internal: 0,
		answered: 0,
		unanswered: 0,
		averageDurationMs: 0,
		averageBillsecMs: 0,
		...overrides,
	};
}

function agent(overrides: Partial<AgentStatsRow> = {}): AgentStatsRow {
	return { ...emptyAgentStats("019fd3c2-1111-76be-a6b3-b0f1914e39b6"), ...overrides };
}

describe("the answer rate", () => {
	it("rounds to one decimal, so a chart is not rendering fifteen digits", () => {
		expect(answerRatePct({ total: 3, answered: 1 })).toBe(33.3);
	});

	/** An idle hour has no answer rate. `0%` would make a quiet Sunday look like an outage. */
	it("reports null rather than 0 for a bucket with no calls", () => {
		expect(answerRatePct({ total: 0, answered: 0 })).toBeNull();
	});
});

describe("the window totals", () => {
	/**
	 * The mean of the per-bucket means is not the mean. A quiet hour with one nine-minute call must
	 * not pull the window's average as hard as a busy hour with two hundred short ones.
	 */
	it("re-weights the average billed time by each bucket's answered count", () => {
		const totals = volumeTotals([
			bucket({ total: 1, answered: 1, averageBillsecMs: 540_000 }),
			bucket({ total: 99, answered: 99, averageBillsecMs: 10_000 }),
		]);
		// The naive average of the two means would be 275_000.
		expect(totals.averageBillsecMs).toBe(15_300);
	});

	it("adds the directions and derives unanswered from the two counts", () => {
		const totals = volumeTotals([
			bucket({ total: 10, inbound: 6, outbound: 3, internal: 1, answered: 7 }),
			bucket({ total: 5, inbound: 5, answered: 1 }),
		]);
		expect(totals.total).toBe(15);
		expect(totals.inbound).toBe(11);
		expect(totals.unanswered).toBe(7);
	});

	it("has no answer rate and no average over an empty window, rather than zero", () => {
		const totals = volumeTotals([]);
		expect(totals.answerRatePct).toBeNull();
		expect(totals.averageBillsecMs).toBe(0);
	});
});

describe("the busiest bucket", () => {
	it("gives a tie to the earlier bucket, which is where a reader is looking", () => {
		const first = bucket({ bucket: "2026-08-05T09:00:00.000Z", total: 9 });
		const second = bucket({ bucket: "2026-08-05T10:00:00.000Z", total: 9 });
		expect(busiestBucket([first, second])?.bucket).toBe(first.bucket);
	});

	it("is undefined for an empty series rather than a zero row that looks real", () => {
		expect(busiestBucket([])).toBeUndefined();
	});
});

describe("the destination breakdown", () => {
	const rows = [
		{ bucket: "a", destinationType: "queue", total: 3, answered: 2 },
		{ bucket: "b", destinationType: "queue", total: 4, answered: 1 },
		{ bucket: "b", destinationType: "ivr", total: 9, answered: 9 },
	];

	it("collapses the per-bucket triples into one row per type, busiest first", () => {
		expect(destinationTotals(rows)).toEqual([
			{ destinationType: "ivr", total: 9, answered: 9 },
			{ destinationType: "queue", total: 7, answered: 3 },
		]);
	});

	/** A legend, a stacked bar and a table must not disagree about which colour is which. */
	it("orders the series keys the same way the totals are ordered", () => {
		expect(
			destinationSeriesKeys({
				data: [],
				destinations: rows,
				bucket: "hour",
				truncated: false,
				range: { from: "a", to: "b" },
			}),
		).toEqual(["ivr", "queue"]);
	});
});

describe("an agent's numbers", () => {
	/**
	 * Talk over talk-plus-wrap-up, never over a wall clock this app invented: nothing here knows
	 * when an agent was logged in, and a utilisation against an assumed eight-hour day would be a
	 * number with an authoritative look and no basis.
	 */
	it("divides talk by talk plus wrap-up, and by nothing else", () => {
		expect(talkSharePct(agent({ talkTimeMs: 900, wrapUpMs: 100 }))).toBe(90);
	});

	it("reports null rather than 0 for an agent who did nothing in the window", () => {
		expect(talkSharePct(agent())).toBeNull();
	});

	/** A mean of one gap and a mean of four hundred must not render identically. */
	it("refuses a wrap-up average built from too few gaps", () => {
		expect(hasUsableWrapUp(agent({ wrapUpSamples: MIN_WRAP_UP_SAMPLES - 1 }))).toBe(false);
		expect(hasUsableWrapUp(agent({ wrapUpSamples: MIN_WRAP_UP_SAMPLES }))).toBe(true);
	});

	it("fills an absent agent with zeroes rather than hiding them from the roster", () => {
		const empty = emptyAgentStats("seat");
		expect(empty.answered).toBe(0);
		expect(empty.queues).toEqual([]);
		// An agent who took no calls closed none, and an empty breakdown is what the table renders
		// as "not asked" rather than as a zero of some code that was never offered.
		expect(empty.dispositions).toEqual([]);
	});
});

describe("the request parameters", () => {
	/** This object IS the cache key: an empty filter and no filter have to be one entry. */
	it("omits an unset or emptied filter rather than sending it blank", () => {
		expect(agentStatsParams({ agentId: "", queueId: undefined })).toEqual({ wrapUpSeconds: 120 });
	});

	it("clamps the wrap-up cap rather than sending one the server would refuse", () => {
		expect(agentStatsParams({ wrapUpSeconds: 99_999 }).wrapUpSeconds).toBe(MAX_WRAP_UP_SECONDS);
		expect(agentStatsParams({ wrapUpSeconds: 0 }).wrapUpSeconds).toBe(1);
	});

	/** The grain is always sent, so the cache key and the axis label are the same fact. */
	it("always sends the bucket grain, defaulted when the caller did not choose", () => {
		expect(callVolumeParams({})).toEqual({ bucket: "hour" });
		expect(callVolumeParams({ bucket: "day" }).bucket).toBe("day");
	});
});
