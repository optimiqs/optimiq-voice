import { Application } from "@optimiq-voice/types";
import { AssistantConfig, ConversationSettings } from "./assistants";
import { LanguageModel } from "./models";
import { Voice } from "./voice";

enum ConversationProvider {
	FILE = "file",
	API = "api",
}

type AutopilotParams = {
	voice: Voice;
	conversationSettings: ConversationSettings;
	languageModel: LanguageModel;
};

type AutopilotApplication = Application & {
	intelligence: {
		productRef: string;
		config: AssistantConfig;
	};
};

export { AutopilotParams, ConversationProvider, AutopilotApplication };
