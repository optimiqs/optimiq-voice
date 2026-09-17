import { describe, expect, it } from "bun:test";
import {
	abandonRatePct,
	describeShortfalls,
	emptyQueueStats,
	formatServiceLevel,
	serviceLevelTone,
	SERVICE_LEVEL_GOAL_PCT,
	SERVICE_LEVEL_WARNING_PCT,
} from "./queue-stats";
import type { QueueStatsRow } from "./contracts";

/**
 * The wallboard's arithmetic and its colours.
 *
 * Every test here is about a rendering that would be plausible and wrong. A wallboard is watched
 * from across a room by somebody deciding whether to intervene, so the failure mode is not a broken
 * page — it is a page that looks fine and says the wrong thing.
 */

const QUEUE = "019fd5fb-de54-700b-8826-8cf8ab5199af";

function row(overrides: Partial<QueueStatsRow> = {}): QueueStatsRow {
	return { ...emptyQueueStats(QUEUE), ...overrides };
}

describe("formatServiceLevel", () => {
	/**
	 * The single most important distinction on this screen. A queue nobody called at 3am and a queue
	 * that answered nothing inside the target are opposite facts, and the server sends `null` for the
	 * first precisely so a client cannot collapse them.
	 */
	it("says 'no traffic' rather than 0% for an idle queue", () => {
		expect(formatServiceLevel(null)).toBe("No traffic");
		expect(formatServiceLevel(0)).toBe("0.0%");
	});

	it("keeps the server's one decimal, so a rounded 100% is not claimed", () => {
		expect(formatServiceLevel(99.9)).toBe("99.9%");
		expect(formatServiceLevel(100)).toBe("100.0%");
		expect(formatServiceLevel(87)).toBe("87.0%");
	});
});

describe("serviceLevelTone", () => {
	/** Idle is NEUTRAL, not a failure — the whole reason the null is carried this far. */
	it("colours an idle queue neutrally", () => {
		expect(serviceLevelTone(null)).toBe("neutral");
	});

	it("bands at the goal and at the warning line, inclusively", () => {
		expect(serviceLevelTone(SERVICE_LEVEL_GOAL_PCT)).toBe("success");
		expect(serviceLevelTone(SERVICE_LEVEL_GOAL_PCT - 0.1)).toBe("warning");
		expect(serviceLevelTone(SERVICE_LEVEL_WARNING_PCT)).toBe("warning");
		expect(serviceLevelTone(SERVICE_LEVEL_WARNING_PCT - 0.1)).toBe("danger");
	});

	/** A queue that took calls and answered none of them in time is the red case, not the null one. */
	it("colours a genuine zero as a failure", () => {
		expect(serviceLevelTone(0)).toBe("danger");
	});
});

describe("abandonRatePct", () => {
	/**
	 * Of OFFERED, on the same denominator the service level uses, so the two columns can be read
	 * against each other. Over "answered plus abandoned" this queue would report 83%, which would
	 * send a supervisor after a staffing problem it does not have.
	 */
	it("divides by everything the queue was asked to serve", () => {
		expect(abandonRatePct(row({ offered: 112, answered: 2, abandoned: 10, noAgents: 100 }))).toBe(
			8.9,
		);
	});

	it("has no answer for a queue with no traffic, rather than answering zero", () => {
		expect(abandonRatePct(row())).toBeNull();
	});
});

describe("describeShortfalls", () => {
	/**
	 * Four endings, four different fixes. Collapsing them into one "unanswered" number is the summary
	 * that hides which one is happening — and `noAgents` in particular is the one whose fix is
	 * somebody logging in, not somebody working faster.
	 */
	it("names each way of not being served, and drops the ones that did not happen", () => {
		expect(describeShortfalls(row({ abandoned: 3, noAgents: 5 }))).toEqual([
			{ label: "Gave up", value: 3 },
			{ label: "Nobody logged in", value: 5 },
		]);
	});

	it("says nothing at all about a queue that served everybody", () => {
		expect(describeShortfalls(row({ offered: 40, answered: 40 }))).toEqual([]);
	});
});

describe("emptyQueueStats", () => {
	/**
	 * A queue with no traffic is ABSENT from the response, so a wallboard listing every configured
	 * queue fills the gap with this. Its service level is `null` and not 0 — the same distinction
	 * everything above turns on, and the reason the placeholder is a function rather than a literal
	 * somebody would fill with zeroes.
	 */
	it("stands in for a queue the window returned nothing for, with no service level", () => {
		const placeholder = emptyQueueStats(QUEUE);

		expect(placeholder.queueId).toBe(QUEUE);
		expect(placeholder.offered).toBe(0);
		expect(placeholder.serviceLevelPct).toBeNull();
		expect(formatServiceLevel(placeholder.serviceLevelPct)).toBe("No traffic");
	});
});
