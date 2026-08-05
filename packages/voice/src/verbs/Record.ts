import { z } from "zod";
import { Messages, RecordRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class Record extends Verb<RecordRequest> {
	getValidationSchema(): z.Schema {
		return z.object({
			maxDuration: z
				.number()
				.int({ message: Messages.POSITIVE_INTEGER_MESSAGE })
				.positive({ message: Messages.POSITIVE_INTEGER_MESSAGE })
				.optional(),
			maxSilence: z
				.number()
				.int({ message: Messages.POSITIVE_INTEGER_MESSAGE })
				.positive({ message: Messages.POSITIVE_INTEGER_MESSAGE })
				.optional(),
			beep: z.boolean().optional(),
			finishOnKey: z
				.string()
				.regex(/^[0-9*#]+$/, { message: Messages.VALID_DTMF })
				.length(1, {
					message: Messages.MUST_BE_A_SINGLE_CHARACTER,
				})
				.optional(),
		});
	}
}

export { Record };
