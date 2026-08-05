import { z } from "zod";
import { Messages, PlayDtmfRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class PlayDtmf extends Verb<PlayDtmfRequest> {
	getValidationSchema(): z.Schema {
		return z.object({
			digits: z.string().regex(/^[0-9*#]+$/, { message: Messages.VALID_DTMF }),
		});
	}
}

export { PlayDtmf };
