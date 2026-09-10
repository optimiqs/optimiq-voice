import { describe, expect, it } from "bun:test";
import { KYC_DECISIONS } from "../pbx/contracts";
import {
	KYC_DECISION_LABELS,
	KYC_DECISION_TONES,
	REVIEWER_DECISIONS,
	TRACEBACK_MAX_RANGE_DAYS,
	decisionNoteIssue,
	tracebackQueryIssue,
} from "./contracts";

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.UTC(2026, 8, 10) + offsetMs).toISOString();

describe("KYC decision presentation", () => {
	it("labels and tones every decision the API can return", () => {
		for (const decision of KYC_DECISIONS) {
			expect(KYC_DECISION_LABELS[decision].length).toBeGreaterThan(0);
			expect(KYC_DECISION_TONES[decision]).toBeDefined();
		}
	});

	/**
	 * The one rule the tenant-facing panel states and this screen has to keep: `needs-info` is the
	 * decision somebody can ACT on, and painting it the same red as a rejection says the application
	 * is over when a reviewer is waiting on them.
	 */
	it("does not paint needs-info as a rejection", () => {
		expect(KYC_DECISION_TONES["needs-info"]).toBe("warning");
		expect(KYC_DECISION_TONES.rejected).toBe("danger");
		expect(KYC_DECISION_TONES.approved).toBe("success");
	});

	it("offers no way to un-decide a file", () => {
		expect(REVIEWER_DECISIONS).not.toContain("pending");
		for (const decision of REVIEWER_DECISIONS) {
			expect(KYC_DECISIONS).toContain(decision);
		}
	});
});

describe("decisionNoteIssue", () => {
	it("lets an approval through with no note", () => {
		expect(decisionNoteIssue("approved", "")).toBeUndefined();
	});

	it("asks for a reason on a rejection", () => {
		expect(decisionNoteIssue("rejected", "")).toContain("Say why");
		expect(decisionNoteIssue("rejected", "   ")).toContain("Say why");
	});

	it("asks what is missing on a needs-info", () => {
		expect(decisionNoteIssue("needs-info", "")).toContain("what is missing");
	});

	it("is satisfied by any real note", () => {
		expect(decisionNoteIssue("rejected", "Entity name does not match the filing.")).toBeUndefined();
		expect(decisionNoteIssue("needs-info", "Send the utility bill.")).toBeUndefined();
	});
});

describe("tracebackQueryIssue", () => {
	const base = { from: iso(0), to: iso(24 * HOUR), calledNumber: "", callingNumber: "" };

	it("refuses a query naming no number, which would be every tenant's calls", () => {
		expect(tracebackQueryIssue(base)).toContain("at least one number");
	});

	it("accepts either end of the call", () => {
		expect(tracebackQueryIssue({ ...base, calledNumber: "1002" })).toBeUndefined();
		expect(tracebackQueryIssue({ ...base, callingNumber: "+12125550100" })).toBeUndefined();
	});

	it("refuses an unparseable window rather than sending it", () => {
		expect(tracebackQueryIssue({ ...base, calledNumber: "1002", from: "" })).toContain(
			"a start and an end",
		);
	});

	it(`refuses a window wider than ${String(TRACEBACK_MAX_RANGE_DAYS)} days`, () => {
		const issue = tracebackQueryIssue({
			...base,
			calledNumber: "1002",
			to: iso(40 * 24 * HOUR),
		});
		expect(issue).toContain("40 days");
		expect(issue).toContain(String(TRACEBACK_MAX_RANGE_DAYS));
	});

	it("allows exactly the ceiling, which the server also allows", () => {
		expect(
			tracebackQueryIssue({
				...base,
				calledNumber: "1002",
				to: iso(TRACEBACK_MAX_RANGE_DAYS * 24 * HOUR),
			}),
		).toBeUndefined();
	});

	/** An inverted range is the server's to swap (`resolveTimeRange`), not this check's to refuse. */
	it("measures an inverted window by its width, not its sign", () => {
		expect(
			tracebackQueryIssue({
				...base,
				calledNumber: "1002",
				from: iso(24 * HOUR),
				to: iso(0),
			}),
		).toBeUndefined();
	});
});
