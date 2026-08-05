import { z } from "zod";
import {
	assistantSchema,
	conversationSettingsSchema,
	languageModelConfigSchema,
} from "@optimiq-voice/common";

type ConversationSettings = z.infer<typeof conversationSettingsSchema>;
type LanguageModelConfig = z.infer<typeof languageModelConfigSchema>;
type AssistantConfig = z.infer<typeof assistantSchema>;

export { AssistantConfig, ConversationSettings, LanguageModelConfig };
