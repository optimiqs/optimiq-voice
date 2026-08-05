import { z } from "zod";
import { Messages, PlayRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class Play extends Verb<PlayRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      url: z.string().url({ message: Messages.VALID_URL }),
      playbackRef: z.string().uuid({ message: Messages.VALID_UUID }).optional()
    });
  }
}

export { Play };
