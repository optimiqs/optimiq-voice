import { z } from "zod";
import { hostOrHostPortSchema } from "@optimiq-voice/common";
import { ApplicationType } from "@optimiq-voice/types";
import { assistantWithoutApiKeySchema } from "./assistantWithoutApiKeySchema";
import { speechValidators } from "./speechValidators";

const MAX_NAME_MESSAGE = "Name must contain at most 255 characters";

function createValidationSchema(request: {
	applicationType: ApplicationType;
	ttsEngineName: string;
	sttEngineName: string;
}) {
	const { applicationType, ttsEngineName, sttEngineName } = request;

	return z.object({
		name: z.string().max(255, MAX_NAME_MESSAGE),
		type: z.nativeEnum(ApplicationType, {
			message: "Invalid application type",
		}),
		endpoint: hostOrHostPortSchema,
		textToSpeech: ttsEngineName
			? z.object({
					productRef: z.string(),
					config: speechValidators.ttsConfigValidators[ttsEngineName](),
				})
			: z.undefined(),
		speechToText: sttEngineName
			? z.object({
					productRef: z.string(),
					config: speechValidators.sttConfigValidators[sttEngineName](),
				})
			: z.undefined(),
		intelligence:
			applicationType === ApplicationType.AUTOPILOT
				? z
						.object({
							productRef: z.string(),
							config: assistantWithoutApiKeySchema,
						})
						.superRefine((data, ctx) => {
							const vendor = data.productRef.split(".")[1];
							const languageModelProvider = data.config.languageModel.provider;

							if (vendor !== languageModelProvider) {
								ctx.addIssue({
									code: z.ZodIssueCode.custom,
									message: `intelligence.productRef (${data.productRef}) must match languageModel.provider (${languageModelProvider}).`,
									path: ["productRef"],
								});
							}
						})
				: z.undefined(),
	});
}

export { createValidationSchema };
