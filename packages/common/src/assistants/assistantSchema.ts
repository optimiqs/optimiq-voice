import { z } from "zod";
import { conversationSettingsSchema } from "./conversationSettingsSchema";
import { eventsHookSchema } from "./eventsHookSchema";
import { languageModelConfigSchema } from "./languageModelConfigSchema";
import { testCasesSchema } from "./testCasesSchema";

const assistantSchema = z.object({
	conversationSettings: conversationSettingsSchema,
	languageModel: languageModelConfigSchema,
	eventsHook: eventsHookSchema.optional(),
	testCases: testCasesSchema.optional(),
});

export { assistantSchema };
