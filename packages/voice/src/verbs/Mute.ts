import { z } from "zod";
import { MuteDirection, MuteRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class Mute extends Verb<MuteRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      direction: z.enum([
        MuteDirection.IN,
        MuteDirection.OUT,
        MuteDirection.BOTH
      ])
    });
  }
}

export { Mute };
