import { ScenarioEvaluationReport } from "@optimiq-voice/types";
import { AssistantConfig } from "../../assistants";
import { Voice } from "../../voice";
import { createLanguageModel } from "../createLanguageModel";
import { TelephonyContext } from "../types";
import { createTestTextSimilarity } from "./createTestTextSimilarity";
import { evaluateScenario } from "./evaluateScenario";
import { textSimilaryPrompt } from "./textSimilaryPrompt";
import { EvalScenario } from "./types";

export async function evalTestCases(autopilotApplication: {
	intelligence: {
		config: AssistantConfig;
	};
}): Promise<ScenarioEvaluationReport[]> {
	const { testCases } = autopilotApplication.intelligence.config;
	const { config: assistantConfig } = autopilotApplication.intelligence;
	const voice = {
		say: async (_: string) => {},
	} as Voice;

	const evaluationReports: ScenarioEvaluationReport[] = [];
	const scenarios = (testCases?.scenarios ?? []) as EvalScenario[];

	for (let i = 0; i < scenarios.length; i++) {
		const scenario = scenarios[i];
		const languageModel = createLanguageModel({
			voice,
			assistantConfig: autopilotApplication.intelligence.config,
			knowledgeBase: {
				load: async () => {},
				queryKnowledgeBase: async (query: string) => query,
			},
			telephonyContext: scenario.telephonyContext as TelephonyContext,
		});

		const testTextSimilarity = createTestTextSimilarity(
			{
				provider: assistantConfig.testCases?.evalsLanguageModel?.provider,
				model: assistantConfig.testCases?.evalsLanguageModel?.model ?? "",
				apiKey: assistantConfig.testCases?.evalsLanguageModel?.apiKey,
			},
			assistantConfig.testCases?.evalsSystemPrompt || textSimilaryPrompt,
		);

		const evaluationReport = await evaluateScenario({
			assistantConfig,
			scenario,
			languageModel,
			testTextSimilarity,
		});
		evaluationReports.push(evaluationReport);
	}

	return evaluationReports;
}
