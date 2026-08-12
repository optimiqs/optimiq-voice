import { describe, expect, it } from "bun:test";
import {
	CDR_EXPORT_MAX_RANGE_DAYS,
	CDR_EXPORT_MAX_ROWS,
	cdrSearchParams,
	DEFAULT_SLA_SECONDS,
	describeExportFilters,
	isSettledExportStatus,
	MAX_CDR_LIMIT,
	MAX_RANGE_DAYS,
	MAX_SLA_SECONDS,
	queueStatsParams,
} from "./client";
import { CDR_EXPORT_FAILURES, CDR_EXPORT_STATUSES } from "./contracts";

describe("cdrSearchParams", () => {
	/**
	 * Omission and emptiness are different requests: the server DEFAULTS an absent range to the
	 * last 24 hours, so `from=` would be a parse failure rather than "no filter".
	 */
	it("omits every unset value rather than sending it empty", () => {
		const params = cdrSearchParams({
			from: undefined,
			to: null,
			search: "",
			direction: "inbound",
		});

		expect(params).toBe("direction=inbound");
	});

	it("serializes booleans and numbers the way the coercing DTO expects", () => {
		const params = new URLSearchParams(cdrSearchParams({ recorded: true, limit: 50 }));

		expect(params.get("recorded")).toBe("true");
		expect(params.get("limit")).toBe("50");
	});

	it("escapes values so a search term cannot break out of the query string", () => {
		const params = new URLSearchParams(cdrSearchParams({ search: "a&b=c d" }));

		expect(params.get("search")).toBe("a&b=c d");
	});
});

/**
 * The export lifecycle, whose closed sets and bounds are mirrored from
 * `apps/api/src/cdr/exports/cdr-exports.dto.ts` and `@optimiq-voice/cdr-db`.
 *
 * These are asserted behaviourally rather than by importing the server's constants, which is the
 * shape the whole `lib/cdr` area already has: unlike `lib/pbx/contracts.spec.ts` — which can import
 * `@optimiq-voice/pbx-db` because it is a workspace package and a devDependency — the CDR schema
 * package is not a dependency of this app, and the two bounds that matter most live in an
 * `apps/api` module rather than in a package at all. So what is pinned here is what the UI DECIDES
 * from those values: when a poll stops, and what a filter echo says. A drifted bound is a number in
 * a sentence; a drifted stopping condition is a tab that polls forever.
 */
describe("the export status vocabulary", () => {
	/**
	 * The stopping condition for `useCdrExportList`'s `refetchInterval`.
	 *
	 * Both terminal states count. A predicate that only settled on `succeeded` would poll a failed
	 * job every three seconds for as long as the tab is open, which is the exact bug this function
	 * exists as a single source of truth to prevent.
	 */
	it("settles on both terminal states and on neither of the other two", () => {
		expect(isSettledExportStatus("succeeded")).toBe(true);
		expect(isSettledExportStatus("failed")).toBe(true);
		expect(isSettledExportStatus("queued")).toBe(false);
		expect(isSettledExportStatus("running")).toBe(false);
	});

	/** Four members and three failure reasons — a fifth of either would fall through every branch. */
	it("has exactly the four statuses and three failure reasons the column checks allow", () => {
		expect([...CDR_EXPORT_STATUSES]).toEqual(["queued", "running", "succeeded", "failed"]);
		expect([...CDR_EXPORT_FAILURES]).toEqual(["too-many-rows", "storage", "internal"]);
		expect(CDR_EXPORT_STATUSES.filter(isSettledExportStatus)).toHaveLength(2);
	});

	/**
	 * The two bounds the export dialog states, held against the list's own so the SHAPE of the claim
	 * cannot invert. The export path exists precisely because a wider question can be asked than a
	 * request can answer; a build where the export window was not wider would be one where the whole
	 * feature had quietly stopped being worth having.
	 */
	it("bounds an export more widely than a list page, which is the point of it", () => {
		expect(CDR_EXPORT_MAX_RANGE_DAYS).toBeGreaterThan(MAX_RANGE_DAYS);
		expect(CDR_EXPORT_MAX_ROWS).toBeGreaterThan(MAX_CDR_LIMIT);
		expect(CDR_EXPORT_MAX_ROWS).toBe(100_000);
		expect(CDR_EXPORT_MAX_RANGE_DAYS).toBe(366);
	});
});

describe("describeExportFilters", () => {
	/**
	 * The window is rendered from `rangeFrom`/`rangeTo`, which are real columns holding what the
	 * server RESOLVED. Echoing `from`/`to` out of the blob as well would show the same fact twice
	 * and let the two disagree the moment a range was defaulted rather than sent.
	 */
	it("leaves the window and the job's own name out, because both are rendered elsewhere", () => {
		expect(
			describeExportFilters({
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-02-01T00:00:00.000Z",
				label: "Q1",
			}),
		).toEqual([]);
	});

	it("labels the filters it knows, and drops the ones that were never set", () => {
		expect(
			describeExportFilters({
				direction: "inbound",
				disposition: undefined,
				extension: "",
				search: "555",
			}),
		).toEqual([
			{ label: "Direction", value: "inbound" },
			{ label: "Search", value: "555" },
		]);
	});

	/**
	 * A job pins the filters as the DTO parsed them at the time, so a job made by a later build may
	 * carry a name this one has never heard of. Passing it through under its own name is the honest
	 * answer: dropping it would render an export as unfiltered when it was not, on the one screen
	 * whose job is to say what a file actually contains.
	 */
	it("passes an unrecognised filter through rather than showing the export as unfiltered", () => {
		expect(describeExportFilters({ someFutureFilter: "x" })).toEqual([
			{ label: "someFutureFilter", value: "x" },
		]);
	});

	/** `recorded` is a boolean on the wire and has to survive as one a reader can see. */
	it("renders a boolean filter as a value rather than dropping it", () => {
		expect(describeExportFilters({ recorded: true })).toEqual([
			{ label: "Recorded only", value: "true" },
		]);
		// `false` is a filter somebody set, not an absence — only `undefined`, `null` and `""` are.
		expect(describeExportFilters({ recorded: false })).toEqual([
			{ label: "Recorded only", value: "false" },
		]);
	});
});

/**
 * The SLA question, as parameters.
 *
 * Two decisions live here and neither is visible from the screen that uses them: what a wallboard
 * asks when nobody has chosen a window, and what happens to a target somebody pushes past the
 * server's ceiling.
 */
describe("queueStatsParams", () => {
	it("always sends a target, because the number is meaningless without one", () => {
		expect(queueStatsParams({})).toEqual({ slaSeconds: DEFAULT_SLA_SECONDS });
	});

	/**
	 * The window is omitted rather than resolved here so the SERVER's default applies and comes back
	 * echoed in `range` — a client that guessed at a default would render a window the response then
	 * disagreed with.
	 */
	it("omits the window and the queue when neither was chosen", () => {
		const params = queueStatsParams({ from: undefined, to: undefined, queueId: undefined });

		expect(Object.keys(params).sort()).toEqual(["slaSeconds"]);
	});

	it("passes a chosen window and a single queue straight through", () => {
		expect(
			queueStatsParams({
				from: "2026-08-01T00:00:00.000Z",
				to: "2026-08-02T00:00:00.000Z",
				queueId: "019fd5fb-de54-700b-8826-8cf8ab5199af",
				slaSeconds: 60,
			}),
		).toEqual({
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-08-02T00:00:00.000Z",
			queueId: "019fd5fb-de54-700b-8826-8cf8ab5199af",
			slaSeconds: 60,
		});
	});

	/**
	 * Clamped rather than sent and refused: a supervisor dragging the control to its end meant "the
	 * maximum", and a 400 in place of a number is the wrong answer to that. The floor is 1 for the
	 * same reason — a zero-second target is not a question anybody is asking.
	 */
	it("clamps the target to the range the server accepts, and rounds a fractional one", () => {
		expect(queueStatsParams({ slaSeconds: MAX_SLA_SECONDS + 1 }).slaSeconds).toBe(MAX_SLA_SECONDS);
		expect(queueStatsParams({ slaSeconds: 0 }).slaSeconds).toBe(1);
		expect(queueStatsParams({ slaSeconds: -30 }).slaSeconds).toBe(1);
		expect(queueStatsParams({ slaSeconds: 20.4 }).slaSeconds).toBe(20);
	});
});
