import { expect } from "chai";
import { ExpectedTextType } from "@optimiq-voice/types";
import { evaluateTextResponse } from "../../src/models/evaluations/evaluateTextResponse";

describe("evaluateTextResponse", () => {
	it("EXACT: passes when strings match", async () => {
		const result = await evaluateTextResponse(
			{ type: ExpectedTextType.EXACT, response: "Hello" },
			"Hello",
			async () => true,
		);
		expect(result.passed).to.be.true;
		expect(result.errorMessage).to.be.undefined;
	});

	it("EXACT: fails when strings differ", async () => {
		const result = await evaluateTextResponse(
			{ type: ExpectedTextType.EXACT, response: "Hello" },
			"Hi",
			async () => true,
		);
		expect(result.passed).to.be.false;
		expect(result.errorMessage).to.include("Expected exact response");
		expect(result.errorMessage).to.include("Hello");
		expect(result.errorMessage).to.include("Hi");
	});

	it("SIMILAR: passes when similarity returns true", async () => {
		const result = await evaluateTextResponse(
			{ type: ExpectedTextType.SIMILAR, response: "Bye" },
			"Goodbye!",
			async () => true,
		);
		expect(result.passed).to.be.true;
	});

	it("SIMILAR: fails when similarity returns false", async () => {
		const result = await evaluateTextResponse(
			{ type: ExpectedTextType.SIMILAR, response: "Yes" },
			"No",
			async () => false,
		);
		expect(result.passed).to.be.false;
		expect(result.errorMessage).to.include("Expected similar response");
	});
});
