import { StepEvaluationReport } from "@optimiq-voice/types";
import { AssistantConfig } from "../../assistants";
import { LanguageModel } from "../types";

type EvalExpectedTool = {
	tool: string;
	parameters?: Record<string, unknown>;
};

type EvalConversationStep = {
	userInput: string;
	expected: {
		text: { type: "EXACT" | "SIMILAR"; response: string };
		tools?: EvalExpectedTool[];
	};
};

type EvalScenario = {
	ref: string;
	description: string;
	telephonyContext: {
		callDirection: string;
		ingressNumber: string;
		callerNumber: string;
		metadata?: Record<string, string>;
	};
	conversation: EvalConversationStep[];
};

type EvaluateIntelligenceRequest = {
	intelligence: {
		productRef: string;
		config: AssistantConfig;
	};
};

type EvaluateStepParams = {
	step: EvalConversationStep;
	languageModel: LanguageModel;
	testTextSimilarity: (text1: string, text2: string) => Promise<boolean>;
	assistantConfig: AssistantConfig;
};

type ScenarioEvaluationRequest = {
	assistantConfig: AssistantConfig;
	scenario: EvalScenario;
	languageModel: LanguageModel;
	testTextSimilarity: (text1: string, text2: string) => Promise<boolean>;
};

type RunEvalCallbacks = {
	onStepResult: (scenarioRef: string, report: StepEvaluationReport) => void | Promise<void>;
	onScenarioComplete: (scenarioRef: string, overallPassed: boolean) => void | Promise<void>;
};

export {
	EvalConversationStep,
	EvalExpectedTool,
	EvalScenario,
	EvaluateIntelligenceRequest,
	EvaluateStepParams,
	RunEvalCallbacks,
	ScenarioEvaluationRequest,
};
