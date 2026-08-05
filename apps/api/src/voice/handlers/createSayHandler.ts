import { Client } from "ari-client";
import { struct } from "pb-util";
import { z } from "zod";
import { SayRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

const sayRequestSchema = z.object({
  text: z.string(),
  mediaSessionRef: z.string(),
  options: z.record(z.unknown()).optional()
});

function createSayHandler(ari: Client, voiceClient: VoiceClient) {
  return withErrorHandling(async (request: SayRequest) => {
    sayRequestSchema.parse(request);

    await voiceClient.synthesize(
      request.text,
      request.options ? struct.decode(request.options) : {}
    );

    voiceClient.sendResponse({
      sayResponse: {
        mediaSessionRef: request.mediaSessionRef
      }
    });
  });
}

export { createSayHandler };
