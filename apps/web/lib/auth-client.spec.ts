import { describe, expect, it } from "bun:test";
import { ApiError } from "./api-client";
import { authErrorMessage, authQueryError } from "./auth-client";
import { createQueryClient } from "./query-client";

/**
 * A better-auth failure has to reach the query client as something it can classify.
 *
 * `query-client.ts` decides whether to retry by `error instanceof ApiError && status is 4xx`. Every
 * better-auth-backed query used to throw a bare `Error`, so a 403 — the answer for any member whose
 * role cannot read organization API keys — was retried with backoff instead of shown, and
 * `/settings/api-keys` sat on its loading panel for seconds before falling to an empty state that
 * claimed the organization had no keys. These tests pin both halves: the shape of the thrown error,
 * and the retry decision the client makes about it.
 */
describe("authQueryError", () => {
	it("carries the better-auth status so a 4xx is recognisable", () => {
		const error = authQueryError({ message: "Forbidden", code: "INSUFFICIENT", status: 403 });
		expect(error).toBeInstanceOf(ApiError);
		expect(error.status).toBe(403);
		expect(error.isForbidden).toBe(true);
		expect(error.message).toBe("Forbidden");
	});

	it("renders the same text authErrorMessage would", () => {
		const raw = { message: "  ", code: "X" };
		expect(authQueryError(raw).message).toBe(authErrorMessage(raw));
		expect(authQueryError(null).message).toBe(authErrorMessage(null));
	});

	it("treats a status-less failure as a server error, so transient ones still retry", () => {
		expect(authQueryError({ message: "boom" }).status).toBe(500);
	});
});

describe("the query client's retry rule, applied to an auth failure", () => {
	const retry = (error: unknown): boolean => {
		const rule = createQueryClient().getDefaultOptions().queries?.retry;
		if (typeof rule !== "function") {
			throw new TypeError("the query default must be a retry predicate");
		}
		return rule(0, error as Error) as boolean;
	};

	it("does not retry a forbidden auth read", () => {
		expect(retry(authQueryError({ message: "Forbidden", status: 403 }))).toBe(false);
	});

	it("does not retry an unauthenticated auth read", () => {
		expect(retry(authQueryError({ message: "Unauthorized", status: 401 }))).toBe(false);
	});

	it("still retries a server-side auth failure", () => {
		expect(retry(authQueryError({ message: "boom", status: 500 }))).toBe(true);
	});

	it("would have retried the bare Error this replaces — the regression this test guards", () => {
		expect(retry(new Error("Forbidden"))).toBe(true);
	});
});
