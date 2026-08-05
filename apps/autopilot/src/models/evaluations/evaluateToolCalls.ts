import { ToolEvaluationReport } from "@optimiq-voice/types";
import { evaluateSingleTool } from "./evaluateSingleTool";
import { EvalExpectedTool } from "./types";

type ToolCallLike = { name: string; args?: Record<string, unknown> };

export function evaluateToolCalls(
	expectedTools: EvalExpectedTool[],
	toolCalls: ToolCallLike[] | undefined,
): {
	evaluations: ToolEvaluationReport[];
	passed: boolean;
	errorMessage?: string;
} {
	const evaluations: ToolEvaluationReport[] = [];

	if (!toolCalls || toolCalls.length !== expectedTools.length) {
		evaluations.push({
			expectedTool: "",
			actualTool: "",
			passed: false,
			expectedParameters: undefined,
			actualParameters: undefined,
			errorMessage: `Expected ${expectedTools.length} tool invocation(s), but got ${toolCalls ? toolCalls.length : 0}.`,
		});
		return {
			evaluations,
			passed: false,
			errorMessage: "Tool invocation count mismatch.",
		};
	}

	for (let i = 0; i < expectedTools.length; i++) {
		evaluations.push(evaluateSingleTool(expectedTools[i], toolCalls[i] as ToolCallLike));
	}

	const overallPassed = evaluations.every((e) => e.passed);
	return {
		evaluations,
		passed: overallPassed,
		errorMessage: overallPassed ? undefined : "One or more tool evaluations failed.",
	};
}
