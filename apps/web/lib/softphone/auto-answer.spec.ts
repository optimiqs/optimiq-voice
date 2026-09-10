import { describe, expect, it } from "bun:test";
import { wantsAutoAnswer } from "./auto-answer";

/**
 * The browser half of the auto-answer agreement.
 *
 * The engine's literals are asserted here verbatim rather than imported: importing them would make
 * this spec pass whatever the engine sent, and the whole risk in a three-way duplicated constant is
 * that one side changes.
 */
describe("wantsAutoAnswer", () => {
	const headers = (values: Record<string, string>) => (name: string) => values[name];

	it("answers a Yealink/Snom style Alert-Info", () => {
		expect(wantsAutoAnswer(headers({ "Alert-Info": "info=alert-autoanswer" }))).toBe(true);
	});

	it("answers when the token hangs off a URI, as Snom's own documentation writes it", () => {
		expect(
			wantsAutoAnswer(headers({ "Alert-Info": "<http://example.com/x>;info=alert-autoanswer" })),
		).toBe(true);
	});

	it("answers a Grandstream/Broadsoft style Call-Info", () => {
		expect(wantsAutoAnswer(headers({ "Call-Info": "<sip:localhost>;answer-after=0" }))).toBe(true);
	});

	it("does NOT answer a delayed answer-after: a tab must not open its microphone later", () => {
		expect(wantsAutoAnswer(headers({ "Call-Info": "<sip:localhost>;answer-after=5" }))).toBe(false);
	});

	it("rings normally for an ordinary call", () => {
		expect(wantsAutoAnswer(headers({}))).toBe(false);
		expect(wantsAutoAnswer(() => undefined)).toBe(false);
		expect(wantsAutoAnswer(() => null)).toBe(false);
	});

	it("ignores the shared-line appearance Call-Info, which is not an answer instruction", () => {
		expect(
			wantsAutoAnswer(headers({ "Call-Info": "<sip:4500@tenant.test>;appearance-index=0" })),
		).toBe(false);
	});
});
