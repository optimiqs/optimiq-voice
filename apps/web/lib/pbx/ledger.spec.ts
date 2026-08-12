import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AUDIT_LIMIT,
	DEFAULT_AUDIT_RANGE_DAYS,
	DEFAULT_EVENT_LIMIT,
	DEFAULT_EVENT_RANGE_DAYS,
	LEDGER_RANGE_PRESETS,
	LEDGER_RANGE_PRESET_LABELS,
	MAX_AUDIT_LIMIT,
	MAX_AUDIT_RANGE_DAYS,
	MAX_EVENT_LIMIT,
	auditRangeIssue,
	cursorPageNumber,
	currentCursor,
	ledgerRangeDays,
	ledgerSearchParams,
	popCursor,
	pushCursor,
	resolveLedgerRange,
	toLocalInputValue,
} from "./ledger";

/**
 * The window and the cursor both screens over an append-only ledger share.
 *
 * The numbers here are the SERVER's — `audit-log.dto.ts` and `sip-auth-event.dto.ts` — restated
 * because neither DTO is importable from a browser bundle. A drifted constant is not a cosmetic
 * failure: a default window that disagrees with the server's shows a range control saying one
 * thing while the table shows another, and a ceiling that disagrees turns a 400 the screen could
 * have explained into an empty table that reads as "there is nothing here".
 *
 * `NOW` is fixed so the preset arithmetic is asserted rather than approximated. A test that
 * computed the expected instant the same way the implementation does would pass whatever the
 * implementation did.
 */

const NOW = new Date("2026-08-05T12:00:00.000Z");
const NO_CUSTOM = { from: "", to: "" };

describe("the server's own numbers", () => {
	/**
	 * Thirty for the change ledger, seven for the attack log — the one place the two ledgers
	 * diverge, and a statement about what each is for: a change history is consulted historically,
	 * an attack log operationally.
	 */
	it("keeps the two default windows apart", () => {
		expect(DEFAULT_AUDIT_RANGE_DAYS).toBe(30);
		expect(DEFAULT_EVENT_RANGE_DAYS).toBe(7);
	});

	it("mirrors the limits each endpoint enforces", () => {
		expect(DEFAULT_AUDIT_LIMIT).toBe(25);
		expect(MAX_AUDIT_LIMIT).toBe(100);
		expect(DEFAULT_EVENT_LIMIT).toBe(50);
		expect(MAX_EVENT_LIMIT).toBe(200);
	});

	/** One year and a day, so "the last year" is never off by a leap day. */
	it("mirrors the change ledger's ceiling", () => {
		expect(MAX_AUDIT_RANGE_DAYS).toBe(366);
	});
});

describe("resolveLedgerRange", () => {
	it("resolves each preset relative to now", () => {
		expect(resolveLedgerRange("24h", NO_CUSTOM, NOW)).toEqual({
			from: "2026-08-04T12:00:00.000Z",
			to: "2026-08-05T12:00:00.000Z",
		});
		expect(resolveLedgerRange("7d", NO_CUSTOM, NOW).from).toBe("2026-07-29T12:00:00.000Z");
		expect(resolveLedgerRange("30d", NO_CUSTOM, NOW).from).toBe("2026-07-06T12:00:00.000Z");
		expect(resolveLedgerRange("90d", NO_CUSTOM, NOW).from).toBe("2026-05-07T12:00:00.000Z");
	});

	/**
	 * A half-filled custom pair sends NOTHING rather than a half-range. The server would either read
	 * the single bound and default the other — silently answering a question nobody asked — or refuse
	 * it, and neither is what a user mid-keystroke meant.
	 */
	it("sends nothing at all for a half-filled custom range", () => {
		expect(resolveLedgerRange("custom", { from: "2026-08-01T00:00", to: "" }, NOW)).toEqual({
			from: undefined,
			to: undefined,
		});
		expect(resolveLedgerRange("custom", { from: "", to: "2026-08-01T00:00" }, NOW).to).toBe(
			undefined,
		);
		expect(resolveLedgerRange("custom", NO_CUSTOM, NOW).from).toBe(undefined);
	});

	it("sends nothing for a custom range that is not readable as dates", () => {
		expect(resolveLedgerRange("custom", { from: "last Tuesday", to: "today" }, NOW).from).toBe(
			undefined,
		);
	});

	it("resolves a complete custom range to instants", () => {
		expect(
			resolveLedgerRange(
				"custom",
				{ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
				NOW,
			),
		).toEqual({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
	});

	/**
	 * Swapped rather than refused, exactly as `resolveAuditRange` does on the server: it is always
	 * two date controls wired in the wrong order, and the intent is unambiguous.
	 */
	it("swaps an inverted custom range instead of refusing it", () => {
		expect(
			resolveLedgerRange(
				"custom",
				{ from: "2026-08-02T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
				NOW,
			),
		).toEqual({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
	});

	it("names every preset it offers", () => {
		for (const preset of LEDGER_RANGE_PRESETS) {
			expect(LEDGER_RANGE_PRESET_LABELS[preset].length).toBeGreaterThan(0);
		}
	});

	/**
	 * Four presets, not three: the change ledger's own default is thirty days and its ceiling is a
	 * year, so "this quarter" is a question somebody genuinely asks and a list that stopped at a
	 * month would push every one of those into the custom pair.
	 */
	it("offers a preset wider than the change ledger's own default", () => {
		expect(LEDGER_RANGE_PRESETS).toContain("90d");
		expect(LEDGER_RANGE_PRESETS).toContain("custom");
	});
});

describe("ledgerRangeDays", () => {
	it("counts whole days, rounding up", () => {
		expect(ledgerRangeDays(resolveLedgerRange("24h", NO_CUSTOM, NOW))).toBe(1);
		expect(ledgerRangeDays(resolveLedgerRange("30d", NO_CUSTOM, NOW))).toBe(30);
		expect(ledgerRangeDays(resolveLedgerRange("90d", NO_CUSTOM, NOW))).toBe(90);
		expect(
			ledgerRangeDays({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-01T00:00:01.000Z" }),
		).toBe(1);
	});

	/** An absent bound is the server's default rather than a zero-length window. */
	it("has no answer for a window that was never sent", () => {
		expect(ledgerRangeDays({ from: undefined, to: undefined })).toBeUndefined();
		expect(ledgerRangeDays({ from: "2026-08-01T00:00:00.000Z", to: undefined })).toBeUndefined();
		expect(ledgerRangeDays({ from: "nonsense", to: "2026-08-01T00:00:00.000Z" })).toBeUndefined();
	});
});

describe("auditRangeIssue", () => {
	/**
	 * Shown beside the control rather than sent and caught, because a 400 that empties the table
	 * reads as "there is nothing here" — the opposite of what a year-wide range means.
	 */
	it("says nothing about a range the server will accept", () => {
		expect(auditRangeIssue(resolveLedgerRange("90d", NO_CUSTOM, NOW))).toBeUndefined();
		expect(
			auditRangeIssue({ from: "2025-08-05T12:00:00.000Z", to: "2026-08-06T12:00:00.000Z" }),
		).toBeUndefined();
	});

	it("mirrors the exception's sentence for a range one day too wide", () => {
		expect(
			auditRangeIssue({ from: "2025-08-04T12:00:00.000Z", to: "2026-08-06T12:00:00.000Z" }),
		).toBe(
			"The requested range spans 367 days; at most 366 may be queried at once. Narrow the range or page through it.",
		);
	});

	/** A window the client did not send is the server's own default, which is never too wide. */
	it("says nothing about a defaulted window", () => {
		expect(auditRangeIssue({ from: undefined, to: undefined })).toBeUndefined();
	});
});

describe("the cursor stack", () => {
	/**
	 * A stack, not a page number, and that is forced by what a keyset cursor IS: it points forward
	 * from an exact position, so "the previous page" cannot be computed — only remembered.
	 */
	it("sends no cursor on the first page", () => {
		expect(currentCursor([])).toBeUndefined();
		expect(currentCursor(["a"])).toBe("a");
		expect(currentCursor(["a", "b"])).toBe("b");
	});

	it("pushes what the server handed back", () => {
		expect(pushCursor([], "a")).toEqual(["a"]);
		expect(pushCursor(["a"], "b")).toEqual(["a", "b"]);
	});

	/**
	 * `null` means the server said this was the last page. Pushing nothing is what keeps "Older"
	 * from advancing into an empty listing.
	 */
	it("refuses to advance past the last page", () => {
		expect(pushCursor(["a"], null)).toEqual(["a"]);
		expect(pushCursor([], null)).toEqual([]);
	});

	it("pops back one page and never underflows", () => {
		expect(popCursor(["a", "b"])).toEqual(["a"]);
		expect(popCursor(["a"])).toEqual([]);
		expect(popCursor([])).toEqual([]);
	});

	/** Push then pop is where an off-by-one would hide, so the round trip is asserted directly. */
	it("returns to exactly where it started", () => {
		const start: readonly string[] = ["a"];
		expect(popCursor(pushCursor(start, "b"))).toEqual(["a"]);
	});

	/**
	 * "Page 3", never "page 3 of 47": there is no `total` and there cannot be one, because a
	 * `count(*)` over a table that takes a row for every mutation forever is the exact cost the
	 * cursor exists to avoid.
	 */
	it("numbers pages from one", () => {
		expect(cursorPageNumber([])).toBe(1);
		expect(cursorPageNumber(["a"])).toBe(2);
		expect(cursorPageNumber(["a", "b"])).toBe(3);
	});
});

describe("ledgerSearchParams", () => {
	it("sends the parameters that are set", () => {
		expect(ledgerSearchParams({ limit: 25, actorType: "user" })).toBe("limit=25&actorType=user");
	});

	/**
	 * Omitted rather than sent empty, and that matters twice over. The server DEFAULTS an absent
	 * window, so `from=` is a parse failure rather than "no filter"; and this object is the React
	 * Query cache key, so `actorType=` and an absent `actorType` have to be ONE cache entry rather
	 * than two that fetch the same rows.
	 */
	it("omits every unset parameter rather than sending it empty", () => {
		expect(
			ledgerSearchParams({ from: undefined, to: null, actorType: "", cursor: "", limit: 25 }),
		).toBe("limit=25");
		expect(ledgerSearchParams({})).toBe("");
	});

	it("produces one string for an unset filter however it is spelled", () => {
		expect(ledgerSearchParams({ limit: 25, scope: undefined })).toBe(
			ledgerSearchParams({ limit: 25 }),
		);
		expect(ledgerSearchParams({ limit: 25, scope: "" })).toBe(ledgerSearchParams({ limit: 25 }));
	});

	/** The window is an ISO instant, whose colons have to survive the round trip percent-encoded. */
	it("encodes an instant so the server parses back what was resolved", () => {
		const query = ledgerSearchParams({ from: "2026-08-05T12:00:00.000Z" });
		expect(query).toBe("from=2026-08-05T12%3A00%3A00.000Z");
		expect(new URLSearchParams(query).get("from")).toBe("2026-08-05T12:00:00.000Z");
	});

	/** Zero is a value, not an absence — the filter-omitting rule must not swallow it. */
	it("keeps a numeric zero", () => {
		expect(ledgerSearchParams({ priority: 0 })).toBe("priority=0");
	});
});

describe("toLocalInputValue", () => {
	it("produces the shape a datetime-local input round trips", () => {
		expect(toLocalInputValue(new Date(2026, 7, 5, 9, 4))).toBe("2026-08-05T09:04");
	});
});
