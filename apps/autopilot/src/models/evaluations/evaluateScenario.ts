import { ScenarioEvaluationReport, StepEvaluationReport } from "@optimiq-voice/types";
import { evaluateStep } from "./evaluateStep";
import { ScenarioEvaluationRequest } from "./types";

export type OnStepResultCallback = (
	scenarioRef: string,
	report: StepEvaluationReport,
) => void | Promise<void>;

export async function evaluateScenario(
	config: ScenarioEvaluationRequest,
	onStepResult?: OnStepResultCallback,
): Promise<ScenarioEvaluationReport> {
	const { scenario, languageModel, testTextSimilarity, assistantConfig } = config;
	const results: StepEvaluationReport[] = [];
	const steps = scenario.conversation;

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const stepResult = await evaluateStep({
			step,
			languageModel,
			testTextSimilarity,
			assistantConfig,
		});
		results.push(stepResult);
		if (onStepResult) await onStepResult(scenario.ref, stepResult);
	}

	const overallPassed = results.every((s) => s.passed);

	return {
		scenarioRef: scenario.ref,
		overallPassed,
		steps: results,
	};
}
