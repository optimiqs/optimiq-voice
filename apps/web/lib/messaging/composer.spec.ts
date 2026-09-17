import { describe, expect, it } from "bun:test";
import { ApiError } from "../api-client";
import { resolveComposerState, type ComposerInput } from "./composer";
import { readSendBlock } from "./errors";

function refusal(code: string, message: string): ApiError {
	return new ApiError(409, message, { statusCode: 409, code, message });
}

function input(overrides: Partial<ComposerInput> = {}): ComposerInput {
	return {
		block: undefined,
		canSendPermission: true,
		hasNumber: true,
		hasRecipient: true,
		bodyLength: 5,
		attachmentCount: 0,
		sending: false,
		...overrides,
	};
}

describe("resolveComposerState", () => {
	it("sends when there is a number, a recipient, the grant and something to say", () => {
		const state = resolveComposerState(input());

		expect(state.canSend).toBe(true);
		expect(state.disabled).toBe(false);
		expect(state.message).toBe("");
	});

	it("sends an attachment with no text", () => {
		expect(resolveComposerState(input({ bodyLength: 0, attachmentCount: 1 })).canSend).toBe(true);
	});

	/**
	 * The three states the API reports. Each disables the composer AND renders the server's own
	 * sentence — that sentence is the only thing that explains a message the carrier would filter,
	 * so it is asserted here character for character.
	 */
	describe("the three refusals the API reports", () => {
		const cases = [
			{
				code: "MESSAGING_NUMBER_NOT_REGISTERED",
				message:
					"+15550101 is not registered with the carriers: the 10DLC campaign “Support replies” is still pending.",
			},
			{
				code: "MESSAGING_RECIPIENT_OPTED_OUT",
				message: "+15550199 replied STOP on 3 February 2026 and has not opted back in.",
			},
			{
				code: "MESSAGING_QUIET_HOURS",
				message: "It is 21:40 in America/New_York; this campaign's quiet hours run 21:00 to 08:00.",
			},
		] as const;

		for (const { code, message } of cases) {
			it(`disables the composer on ${code} and shows the API's message verbatim`, () => {
				const block = readSendBlock(refusal(code, message));
				const state = resolveComposerState(input({ block }));

				expect(state.canSend).toBe(false);
				expect(state.disabled).toBe(true);
				expect(state.reason).toBe("policy");
				expect(state.message).toBe(message);
				expect(state.fromServer).toBe(true);
				// Never a generic line in place of the reason.
				expect(state.message).not.toContain("cannot send");
			});
		}

		it("gives the three refusals three different headings", () => {
			const titles = cases.map(
				({ code, message }) =>
					resolveComposerState(input({ block: readSendBlock(refusal(code, message)) })).title,
			);

			expect(new Set(titles).size).toBe(3);
		});

		/**
		 * A policy refusal outranks the permission check: it is true whatever the caller's role is,
		 * and it is the more useful thing to say than "ask for a grant" that would not help.
		 */
		it("outranks every other reason", () => {
			const block = readSendBlock(refusal("MESSAGING_QUIET_HOURS", "Quiet until 08:00."));
			const state = resolveComposerState(
				input({ block, canSendPermission: false, hasNumber: false, bodyLength: 0 }),
			);

			expect(state.reason).toBe("policy");
			expect(state.message).toBe("Quiet until 08:00.");
		});
	});

	it("explains a missing grant in terms of the permission the API checks", () => {
		const state = resolveComposerState(input({ canSendPermission: false }));

		expect(state.reason).toBe("forbidden");
		expect(state.disabled).toBe(true);
		expect(state.message).toContain("messaging.send");
	});

	it("names the missing number and the missing thread separately", () => {
		expect(resolveComposerState(input({ hasNumber: false })).reason).toBe("no-number");
		expect(resolveComposerState(input({ hasRecipient: false })).reason).toBe("no-conversation");
	});

	/**
	 * An empty composer stops the SEND, not the typing. There is nothing to explain and no reason
	 * to lock the text area somebody is about to fill in.
	 */
	it("does not disable the text area just because it is empty", () => {
		const state = resolveComposerState(input({ bodyLength: 0, attachmentCount: 0 }));

		expect(state.canSend).toBe(false);
		expect(state.disabled).toBe(false);
		expect(state.reason).toBe("empty");
		expect(state.message).toBe("");
	});

	it("refuses a second send while one is in flight, without explaining itself", () => {
		const state = resolveComposerState(input({ sending: true }));

		expect(state.canSend).toBe(false);
		expect(state.disabled).toBe(false);
		expect(state.title).toBe("");
	});
});
