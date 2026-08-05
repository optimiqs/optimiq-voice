import { z } from "zod";
import { GatherRequest, GatherSource, Messages } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class Gather extends Verb<GatherRequest> {
	getValidationSchema(): z.Schema {
		return z.object({
			source: z
				.nativeEnum(GatherSource, {
					message: "Invalid gather source.",
				})
				.optional(),
			finishOnKey: z
				.string()
				.regex(/^[0-9*#]+$/, { message: Messages.VALID_DTMF })
				.length(1, { message: Messages.MUST_BE_A_SINGLE_CHARACTER })
				.optional(),
			timeout: z
				.number()
				.int({ message: Messages.POSITIVE_INTEGER_MESSAGE })
				.positive({ message: Messages.POSITIVE_INTEGER_MESSAGE })
				.optional(),
			maxDigits: z
				.number({
					message: Messages.POSITIVE_INTEGER_MESSAGE,
				})
				.int({
					message: Messages.POSITIVE_INTEGER_MESSAGE,
				})
				.positive({
					message: Messages.POSITIVE_INTEGER_MESSAGE,
				})
				.optional(),
		});
	}
}

export { Gather };
