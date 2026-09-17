import { describe, expect, it } from "bun:test";
import { MAX_PAGE_LIMIT, pbxListSearchParams } from "./client";
import { mergeSelectedOption, PICKER_PAGE_LIMIT, pickerSearchTerm } from "./picker";
import type { PickerOption } from "./picker";

/**
 * A picker reads one page, so the rows past the first hundred are reachable only through the
 * server's `?search=`. These hold the two halves of that: the term the picker sends, and the
 * guarantee that turning the page into a search result never loses the value already selected.
 */

const ROWS: readonly PickerOption[] = [
	{ id: "a", label: "Reception" },
	{ id: "b", label: "Sales" },
];

const NEVER_SEEN = new Map<string, string>();
const FALLBACK = (id: string) => `Currently: ${id.slice(0, 8)}…`;

describe("pickerSearchTerm", () => {
	it("sends nothing for a blank or whitespace-only box", () => {
		expect(pickerSearchTerm("")).toBeUndefined();
		expect(pickerSearchTerm("   ")).toBeUndefined();
	});

	it("trims the term the operator typed", () => {
		expect(pickerSearchTerm("  sales ")).toBe("sales");
	});

	it("produces a term the list client actually puts on the wire", () => {
		const term = pickerSearchTerm(" sales ");
		const params = new URLSearchParams(
			pbxListSearchParams({ page: 1, limit: PICKER_PAGE_LIMIT, search: term }),
		);
		expect(params.get("search")).toBe("sales");
		expect(params.get("limit")).toBe(String(MAX_PAGE_LIMIT));
	});

	it("leaves the unsearched query identical to the one before search existed", () => {
		const params = new URLSearchParams(
			pbxListSearchParams({ page: 1, limit: PICKER_PAGE_LIMIT, search: pickerSearchTerm("") }),
		);
		expect(params.has("search")).toBe(false);
	});
});

describe("mergeSelectedOption", () => {
	it("leaves the page alone when nothing is selected", () => {
		expect(mergeSelectedOption(ROWS, "", NEVER_SEEN, FALLBACK)).toBe(ROWS);
	});

	it("leaves the page alone when it already holds the selected row", () => {
		expect(mergeSelectedOption(ROWS, "b", NEVER_SEEN, FALLBACK)).toBe(ROWS);
	});

	it("keeps a selected row that the current search page filtered out, with its real label", () => {
		const remembered = new Map([["z", "Support"]]);
		const offered = mergeSelectedOption(ROWS, "z", remembered, FALLBACK);
		expect(offered).toHaveLength(3);
		// First, so the operator sees the current value without scrolling a hundred rows.
		expect(offered[0]).toEqual({ id: "z", label: "Support" });
		expect(offered.some((option) => option.id === "z")).toBe(true);
	});

	it("still offers a selected row it has never seen, rather than dropping the value", () => {
		const offered = mergeSelectedOption(ROWS, "0193f2aa-dead", NEVER_SEEN, FALLBACK);
		expect(offered[0]?.id).toBe("0193f2aa-dead");
		expect(offered[0]?.label).toBe("Currently: 0193f2aa…");
	});
});
