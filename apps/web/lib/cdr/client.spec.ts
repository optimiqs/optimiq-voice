import { describe, expect, it } from "bun:test";
import { cdrSearchParams } from "./client";

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
