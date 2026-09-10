import { afterEach, describe, expect, it } from "bun:test";
import {
	applyErasure,
	erasureBody,
	erasureConfirmMatches,
	isEmptyErasure,
	previewErasure,
} from "./erasure";

/**
 * The erasure client.
 *
 * Three things are worth pinning here and nothing else is: the request carries exactly ONE
 * selector, the response is unwrapped from its envelope into the four counts, and the confirm step
 * refuses a re-type that does not match. The first two are what the server's `strictObject` and its
 * `{ data }` envelope demand; the third is the only thing standing between a transposed digit and
 * somebody else's recordings.
 */

const realFetch = globalThis.fetch;

interface Captured {
	readonly url: string;
	readonly method: string | undefined;
	readonly body: unknown;
}

function stubFetch(payload: unknown, captured: Captured[]): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		captured.push({
			url: String(input),
			method: init?.method,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
		});
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof globalThis.fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

const COUNTS = { recordings: 3, voicemailMessages: 1, callLegs: 7, objects: 4 };

describe("erasureBody", () => {
	/**
	 * One key, never two. The server's schema refuses both-and-neither with a 400 raised at the ROOT
	 * of the object — there is no field to blame — which is exactly the error a form cannot render
	 * against a control, so the request is built so it cannot happen.
	 */
	it("carries exactly one selector", () => {
		expect(erasureBody("phoneNumber", "+12125550100")).toEqual({ phoneNumber: "+12125550100" });
		expect(erasureBody("extension", "1001")).toEqual({ extension: "1001" });
	});

	it("trims, because a pasted number carries a trailing space and is not a different person", () => {
		expect(erasureBody("phoneNumber", "  +12125550100 ")).toEqual({
			phoneNumber: "+12125550100",
		});
	});
});

describe("previewErasure", () => {
	it("posts the subject to the preview route and unwraps the counts", async () => {
		const captured: Captured[] = [];
		stubFetch({ data: COUNTS }, captured);

		const counts = await previewErasure({ phoneNumber: "+12125550100" });

		expect(counts).toEqual(COUNTS);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("/api/v1/erasure/preview");
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.body).toEqual({ phoneNumber: "+12125550100" });
	});
});

describe("applyErasure", () => {
	/**
	 * The apply route is the collection root, not `/erasure/apply`. Getting that wrong would 404
	 * against a screen whose only other outcome is irreversible, so it is pinned.
	 */
	it("posts to the erasure route itself and unwraps the counts", async () => {
		const captured: Captured[] = [];
		stubFetch({ data: COUNTS }, captured);

		const counts = await applyErasure({ extension: "1001" });

		expect(counts).toEqual(COUNTS);
		expect(captured[0]?.url).toBe("/api/v1/erasure");
		expect(captured[0]?.body).toEqual({ extension: "1001" });
	});

	/** A second apply legitimately finds nothing. Zeroes are a result, not a failure. */
	it("reads an all-zero answer as nothing left to erase", async () => {
		const captured: Captured[] = [];
		const empty = { recordings: 0, voicemailMessages: 0, callLegs: 0, objects: 0 };
		stubFetch({ data: empty }, captured);

		expect(isEmptyErasure(await applyErasure({ extension: "1001" }))).toBe(true);
		expect(isEmptyErasure(COUNTS)).toBe(false);
	});
});

describe("erasureConfirmMatches", () => {
	it("accepts an exact re-type, trimmed on both sides", () => {
		expect(erasureConfirmMatches("+12125550100", "+12125550100")).toBe(true);
		expect(erasureConfirmMatches(" +12125550100 ", "+12125550100")).toBe(true);
	});

	/**
	 * The failure this whole step exists for: one wrong digit erases a different person's
	 * recordings and reports success.
	 */
	it("refuses a transposed digit, a prefix and a suffix", () => {
		expect(erasureConfirmMatches("+12125550100", "+12125550010")).toBe(false);
		expect(erasureConfirmMatches("+12125550100", "+1212555010")).toBe(false);
		expect(erasureConfirmMatches("+12125550100", "+121255501000")).toBe(false);
	});

	/** Not case-insensitive: `a1` and `A1` are two extensions on a platform that allows both. */
	it("refuses a re-type that differs only in case", () => {
		expect(erasureConfirmMatches("a1", "A1")).toBe(false);
	});

	/** An empty subject can never be confirmed, so an empty box cannot arm the button. */
	it("refuses an empty subject however it is typed", () => {
		expect(erasureConfirmMatches("", "")).toBe(false);
		expect(erasureConfirmMatches("   ", "")).toBe(false);
	});
});
