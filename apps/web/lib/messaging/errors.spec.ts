import { describe, expect, it } from "bun:test";
import { ApiError } from "../api-client";
import { MESSAGING_BLOCK_CODES, messagingToastMessage, readSendBlock } from "./errors";

function refusal(code: string, message: string, statusCode = 409): ApiError {
	return new ApiError(statusCode, message, { statusCode, code, message });
}

/**
 * The three refusals are the product. Each carries a sentence only the server can write — which
 * number, which campaign, which clock — and the composer shows it verbatim, so what is pinned here
 * is that nothing between the wire and the control rewrites, truncates or replaces it.
 */
describe("readSendBlock", () => {
	it("recognises exactly three codes", () => {
		expect([...MESSAGING_BLOCK_CODES]).toEqual([
			"MESSAGING_NUMBER_NOT_REGISTERED",
			"MESSAGING_RECIPIENT_OPTED_OUT",
			"MESSAGING_QUIET_HOURS",
		]);
	});

	it("passes the unregistered-number reason through word for word", () => {
		const message =
			"+15550101 is not registered with the carriers: the 10DLC campaign “Support replies” is still pending.";

		expect(readSendBlock(refusal("MESSAGING_NUMBER_NOT_REGISTERED", message))).toEqual({
			code: "MESSAGING_NUMBER_NOT_REGISTERED",
			title: "This number is not registered for messaging",
			message,
		});
	});

	it("passes the opt-out reason through word for word", () => {
		const message = "+15550199 replied STOP on 3 February 2026 and has not opted back in.";

		expect(readSendBlock(refusal("MESSAGING_RECIPIENT_OPTED_OUT", message))?.message).toBe(message);
	});

	it("passes the quiet-hours reason through word for word", () => {
		const message =
			"It is 21:40 in America/New_York; this campaign's quiet hours run 21:00 to 08:00.";

		expect(readSendBlock(refusal("MESSAGING_QUIET_HOURS", message))?.message).toBe(message);
	});

	/**
	 * A transient failure must NOT latch the composer shut. Only a stated policy refusal disables
	 * the control; a 500 or a dropped connection is something to try again.
	 */
	it("is not a block for anything else", () => {
		expect(
			readSendBlock(refusal("MESSAGING_SEND_FAILED", "Carrier timed out", 502)),
		).toBeUndefined();
		expect(readSendBlock(new ApiError(500, "Internal error", null))).toBeUndefined();
		expect(readSendBlock(new Error("network down"))).toBeUndefined();
		expect(readSendBlock(undefined)).toBeUndefined();
	});

	/**
	 * The code alone is enough to close the composer. The fallback names the category rather than
	 * inventing a reason the server did not give.
	 */
	it("still blocks when the server sent a code and no sentence", () => {
		const block = readSendBlock(
			new ApiError(409, "", { statusCode: 409, code: "MESSAGING_QUIET_HOURS" }),
		);

		expect(block?.code).toBe("MESSAGING_QUIET_HOURS");
		expect(block?.message.length).toBeGreaterThan(0);
	});

	it("gives each code its own heading", () => {
		const titles = MESSAGING_BLOCK_CODES.map(
			(code) => readSendBlock(refusal(code, "because"))?.title,
		);

		expect(new Set(titles).size).toBe(MESSAGING_BLOCK_CODES.length);
	});
});

describe("messagingToastMessage", () => {
	it("prefers the server's own words", () => {
		expect(messagingToastMessage(new ApiError(413, "That image is 12 MB", null), "fallback")).toBe(
			"That image is 12 MB",
		);
	});

	it("falls back for anything that is not an API failure", () => {
		expect(messagingToastMessage(new Error(""), "Could not send")).toBe("Could not send");
	});
});
