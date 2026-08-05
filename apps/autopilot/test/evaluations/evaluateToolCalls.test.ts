import { expect } from "chai";
import { evaluateSingleTool } from "../../src/models/evaluations/evaluateSingleTool";
import { evaluateToolCalls } from "../../src/models/evaluations/evaluateToolCalls";

describe("evaluateSingleTool", () => {
	it("passes when tool name and params match", () => {
		const result = evaluateSingleTool(
			{ tool: "book", parameters: { date: "2024-01-01" } },
			{ name: "book", args: { date: "2024-01-01" } },
		);
		expect(result.passed).to.be.true;
	});

	it("fails when tool name differs", () => {
		const result = evaluateSingleTool(
			{ tool: "book", parameters: {} },
			{ name: "cancel", args: {} },
		);
		expect(result.passed).to.be.false;
		expect(result.errorMessage).to.include('Expected tool "book"');
	});

	it("accepts valid-date placeholder for ISO date param", () => {
		const result = evaluateSingleTool(
			{ tool: "book", parameters: { date: "valid-date" } },
			{ name: "book", args: { date: "2024-06-15" } },
		);
		expect(result.passed).to.be.true;
	});

	it("fails when date param is invalid for valid-date placeholder", () => {
		const result = evaluateSingleTool(
			{ tool: "book", parameters: { date: "valid-date" } },
			{ name: "book", args: { date: "not-a-date" } },
		);
		expect(result.passed).to.be.false;
		expect(result.errorMessage).to.include("valid date");
	});
});

describe("evaluateToolCalls", () => {
	it("passes when count and each tool match", () => {
		const result = evaluateToolCalls([{ tool: "a", parameters: {} }], [{ name: "a", args: {} }]);
		expect(result.passed).to.be.true;
		expect(result.evaluations).to.have.length(1);
	});

	it("fails when tool count mismatch", () => {
		const result = evaluateToolCalls([{ tool: "a" }, { tool: "b" }], [{ name: "a", args: {} }]);
		expect(result.passed).to.be.false;
		expect(result.errorMessage).to.include("count");
	});

	it("fails when actual tool calls undefined", () => {
		const result = evaluateToolCalls([{ tool: "a" }], undefined);
		expect(result.passed).to.be.false;
	});
});
