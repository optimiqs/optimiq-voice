import { ServerInterceptingCall } from "@grpc/grpc-js";
import { Struct, struct } from "pb-util";
import { z } from "zod";
import {
	assistantSchema,
	findIntegrationsCredentials,
	getAccessKeyIdFromCall,
	IntegrationConfig,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { createEvalEffectiveConfig } from "./createEvalEffectiveConfig";
import { runEval } from "./runEval";
import {
	evalErrorToEventPayload,
	scenarioSummaryToEventPayload,
	stepReportToEventPayload,
} from "./stepReportToEventPayload";
import { EvaluateIntelligenceRequest } from "./types";

const logger = getLogger({ service: "api", filePath: __filename });

type ServerStreamCall = {
	request: EvaluateIntelligenceRequest;
	write: (chunk: Record<string, unknown>) => void;
	end: () => void;
};

function createEvaluateIntelligence(integrations: IntegrationConfig[]) {
	const evaluateIntelligence = async (call: ServerStreamCall): Promise<void> => {
		const { request } = call;
		const { intelligence } = request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to evaluateIntelligence", {
			accessKeyId,
			llmProductRef: intelligence.productRef,
			evalLlmProductRef: "llm.openai",
		});

		try {
			const config = struct.decode(intelligence.config as unknown as Struct);

			const parsedIntelligence = z
				.object({
					productRef: z.string(),
					config: assistantSchema,
				})
				.parse({
					productRef: intelligence.productRef,
					config,
				});

			const credentials = findIntegrationsCredentials(integrations, intelligence.productRef) as {
				apiKey: string;
			};

			const evaluationApiKey = findIntegrationsCredentials(integrations, "llm.openai") as {
				apiKey: string;
			};

			const effectiveConfig = createEvalEffectiveConfig(
				parsedIntelligence.config,
				credentials,
				evaluationApiKey,
			);

			await runEval(
				{ intelligence: { config: effectiveConfig } },
				{
					onStepResult: (scenarioRef, stepReport) => {
						const payload = stepReportToEventPayload(scenarioRef, stepReport);
						call.write(payload);
					},
					onScenarioComplete: (scenarioRef, overallPassed) => {
						const payload = scenarioSummaryToEventPayload(scenarioRef, overallPassed);
						call.write(payload);
					},
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			call.write(evalErrorToEventPayload(message));
		} finally {
			call.end();
		}
	};

	return evaluateIntelligence;
}

export { createEvaluateIntelligence };
