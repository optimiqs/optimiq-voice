import { z } from "zod";
import { LanguageModelProvider } from "./language-model-provider";
import * as Messages from "./messages";
import { toolSchema } from "./tool-schema";

const NUMBER_BETWEEN_0_AND_2 = "Must be a number between 0 and 2";

const languageModelConfigSchema = z.object({
	provider: z.nativeEnum(LanguageModelProvider, {
		message: "Invalid language model provider.",
	}),
	model: z.string(),
	temperature: z.coerce
		.number()
		.max(2, { message: NUMBER_BETWEEN_0_AND_2 })
		.min(0, { message: NUMBER_BETWEEN_0_AND_2 }),
	maxTokens: z.coerce
		.number()
		.int({ message: Messages.POSITIVE_INTEGER_MESSAGE })
		.positive({ message: Messages.POSITIVE_INTEGER_MESSAGE }),
	tools: z.array(toolSchema).optional(),
});

export { languageModelConfigSchema };
