import {
	AssistantConfig,
	hangupToolDefinition,
	KnowledgeBase,
	LanguageModelFactory,
	TelephonyContext,
	transferToolDefinition,
	Voice,
} from "..";

function createLanguageModel(params: {
	voice: Voice;
	assistantConfig: AssistantConfig;
	knowledgeBase: KnowledgeBase;
	telephonyContext: TelephonyContext;
}) {
	const { voice, assistantConfig, knowledgeBase, telephonyContext } = params;
	const { languageModel, conversationSettings } = assistantConfig;

	// The transfer tool is only added if the transfer options exist
	const tools = languageModel.tools.concat(
		conversationSettings.transferOptions
			? [hangupToolDefinition, transferToolDefinition]
			: [hangupToolDefinition],
	);

	return LanguageModelFactory.getLanguageModel(
		languageModel.provider,
		{
			...languageModel,
			...conversationSettings,
			knowledgeBase,
			tools,
		} as any,
		voice,
		telephonyContext,
	);
}

export { createLanguageModel };
