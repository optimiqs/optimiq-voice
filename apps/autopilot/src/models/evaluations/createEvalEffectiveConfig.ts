import { AssistantConfig } from "../../assistants";

export function createEvalEffectiveConfig(
  config: AssistantConfig,
  credentials: { apiKey: string },
  evaluationApiKey: { apiKey: string }
) {
  return {
    ...config,
    languageModel: {
      ...config.languageModel,
      apiKey: credentials.apiKey
    },
    testCases: {
      ...config.testCases,
      evalsLanguageModel: {
        ...config.testCases.evalsLanguageModel,
        apiKey: evaluationApiKey.apiKey
      }
    }
  };
}
