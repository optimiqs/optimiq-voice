import { StepEvaluationReport } from "@optimiq-voice/types";
import { evaluateTextResponse } from "./evaluateTextResponse";
import { evaluateToolCalls } from "./evaluateToolCalls";
import { extractAiResponse } from "./extractAiResponse";
import { EvaluateStepParams } from "./types";
import type { ExpectedTextType } from "@optimiq-voice/types";

export async function evaluateStep({
	step,
	languageModel,
	testTextSimilarity,
	assistantConfig,
}: EvaluateStepParams): Promise<StepEvaluationReport> {
	const stepResult: StepEvaluationReport = {
		humanInput: step.userInput,
		expectedResponse: step.expected.text.response,
		aiResponse: "",
		evaluationType: step.expected.text.type as unknown as ExpectedTextType,
		passed: true,
	};

	try {
		const response = await languageModel.invoke(step.userInput);
		stepResult.aiResponse = extractAiResponse(response, assistantConfig);

		const textEvaluation = await evaluateTextResponse(
			{
				type: step.expected.text.type as unknown as ExpectedTextType,
				response: step.expected.text.response,
			},
			stepResult.aiResponse,
			testTextSimilarity,
		);

		if (!textEvaluation.passed) {
			stepResult.passed = false;
			stepResult.errorMessage = textEvaluation.errorMessage;
		}

		if (step.expected.tools && step.expected.tools.length > 0) {
			const toolCalls = response.toolCalls?.filter((tc) => tc?.name) ?? [];
			const toolsEvaluation = evaluateToolCalls(step.expected.tools, toolCalls);
			stepResult.toolEvaluations = toolsEvaluation.evaluations;
			if (!toolsEvaluation.passed) {
				stepResult.passed = false;
				stepResult.errorMessage = stepResult.errorMessage
					? `${stepResult.errorMessage} ${toolsEvaluation.errorMessage}`
					: toolsEvaluation.errorMessage;
			}
		}
	} catch (error) {
		stepResult.passed = false;
		stepResult.errorMessage = `Language model error for input "${step.userInput}": ${error}`;
	}
	return stepResult;
}
