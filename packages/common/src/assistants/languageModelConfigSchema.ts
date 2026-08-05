import { z } from "zod";
import * as Messages from "../messages";
import { LanguageModelProvider } from "./LanguageModelProvider";
import { toolSchema } from "./tools";

const NUMBER_BETWEEN_0_AND_2 = "Must be a number between 0 and 2";

const languageModelConfigSchema = z.object({
	provider: z.nativeEnum(LanguageModelProvider, {
		message: "Invalid language model provider.",
	}),
	apiKey: z.string().optional(),
	model: z.string(),
	temperature: z
		.number()
		.max(2, { message: NUMBER_BETWEEN_0_AND_2 })
		.min(0, { message: NUMBER_BETWEEN_0_AND_2 }),
	maxTokens: z
		.number()
		.int({ message: Messages.POSITIVE_INTEGER_MESSAGE })
		.positive({ message: Messages.POSITIVE_INTEGER_MESSAGE }),
	baseUrl: z
		.string()
		.url({
			message: Messages.VALID_URL,
		})
		.optional(),
	knowledgeBase: z
		.array(
			z.object({
				type: z.enum(["s3"]),
				title: z.string(),
				document: z.string().regex(/\.pdf$/, {
					message: "Document must be a pdf file",
				}),
			}),
		)
		.default([]),
	tools: z.array(toolSchema).default([]),
});

export { languageModelConfigSchema };
