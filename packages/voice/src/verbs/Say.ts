import { z } from "zod";
import { Messages, SayRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class Say extends Verb<SayRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      text: z.string().min(1),
      playbackRef: z.string().uuid({ message: Messages.VALID_UUID }).optional()
    });
  }
}

export { Say };
