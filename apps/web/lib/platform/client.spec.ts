import { describe, expect, it } from "bun:test";
import { API_BASE_PATH } from "../api-client";
import { platformSearchParams, tracebackCsvHref } from "./client";

describe("platformSearchParams", () => {
	it("omits every unset value rather than sending it empty", () => {
		expect(
			platformSearchParams({ decision: undefined, page: null, limit: "", calledNumber: "1002" }),
		).toBe("calledNumber=1002");
	});

	it("serializes numbers the way the coercing DTO expects", () => {
		const params = new URLSearchParams(platformSearchParams({ page: 3, limit: 25 }));
		expect(params.get("page")).toBe("3");
		expect(params.get("limit")).toBe("25");
	});

	it("keeps a zero, which is a value and not an absence", () => {
		expect(platformSearchParams({ limit: 0 })).toBe("limit=0");
	});

	it("escapes a number that carries a plus, so +1 does not arrive as a space", () => {
		const params = new URLSearchParams(platformSearchParams({ callingNumber: "+12125550100" }));
		expect(params.get("callingNumber")).toBe("+12125550100");
	});
});

describe("tracebackCsvHref", () => {
	it("points at the export route under the API base path", () => {
		const href = tracebackCsvHref({
			from: "2026-09-01T00:00:00.000Z",
			to: "2026-09-08T00:00:00.000Z",
			calledNumber: "1002",
		});
		expect(href.startsWith(`${API_BASE_PATH}/platform/traceback/export.csv?`)).toBe(true);
	});

	it("carries exactly the query that was asked, and nothing that was not", () => {
		const href = tracebackCsvHref({
			from: "2026-09-01T00:00:00.000Z",
			to: "2026-09-08T00:00:00.000Z",
			calledNumber: "1002",
			callingNumber: undefined,
			trunkId: undefined,
			limit: 500,
		});
		const params = new URLSearchParams(href.split("?")[1]);
		expect([...params.keys()].sort()).toEqual(["calledNumber", "from", "limit", "to"]);
		expect(params.get("from")).toBe("2026-09-01T00:00:00.000Z");
	});

	/**
	 * The download must answer the question that was ASKED. A relative URL is what keeps it
	 * same-origin, and same-origin is what carries the session cookie through the Next rewrite —
	 * an absolute one pointed at another origin would download an unauthenticated 401 page.
	 */
	it("is relative, so the session cookie rides along", () => {
		const href = tracebackCsvHref({ from: "a", to: "b", calledNumber: "1" });
		expect(href.startsWith("/")).toBe(true);
	});
});
