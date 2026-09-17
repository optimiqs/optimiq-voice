import { describe, expect, it } from "bun:test";
import { forwardModeCopy, forwardTargetError } from "./voicemail-forward";

/**
 * The two pure decisions behind the forward dialog.
 *
 * `forwardTargetError` is the one that matters: it gates the confirm button, so a false `undefined`
 * sends a request the server will refuse and a false error makes a legal destination unusable. The
 * copy pair is asserted for the one property that is easy to break by editing one branch — the two
 * modes must not describe the same outcome, because whether the message stays IS the difference.
 */

const SOURCE = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const TARGET = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

describe("choosing a mailbox to forward into", () => {
	it("accepts another mailbox", () => {
		expect(forwardTargetError(SOURCE, TARGET)).toBeUndefined();
	});

	it("asks for a choice when nothing is selected", () => {
		expect(forwardTargetError(SOURCE, "")).toBe("Choose a mailbox to send this message to.");
	});

	it("explains the same-mailbox case rather than repeating the instruction", () => {
		// The server answers this with a 400; saying so here is what stops the user re-picking the
		// row they just picked.
		expect(forwardTargetError(SOURCE, SOURCE)).toBe(
			"That is the mailbox this message is already in.",
		);
	});
});

describe("what the dialog says per mode", () => {
	it("says the message MOVES when forwarding", () => {
		const copy = forwardModeCopy("forward");
		expect(copy.description).toContain("removed from this one");
		expect(copy.confirm).toBe("Forward message");
	});

	it("says the message STAYS when copying", () => {
		const copy = forwardModeCopy("copy");
		expect(copy.description).toContain("stays in this one");
		expect(copy.confirm).toBe("Copy message");
	});

	it("never describes the two modes identically", () => {
		const forward = forwardModeCopy("forward");
		const copied = forwardModeCopy("copy");
		expect(forward.title).not.toBe(copied.title);
		expect(forward.description).not.toBe(copied.description);
		expect(forward.confirm).not.toBe(copied.confirm);
	});
});
