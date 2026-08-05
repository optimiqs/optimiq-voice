import { z } from "zod";
import {
  StartStreamGatherRequest,
  StreamGatherSource
} from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

const gatherRequestSchema = z.object({
  source: z.optional(
    z.nativeEnum(StreamGatherSource, {
      message: "Invalid stream gather source."
    })
  )
});

function createStreamGatherHandler(voiceClient: VoiceClient) {
  return withErrorHandling(async (request: StartStreamGatherRequest) => {
    const { mediaSessionRef, source } = request;

    gatherRequestSchema.parse(request);

    const effectiveSource = source || StreamGatherSource.SPEECH_AND_DTMF;

    if (effectiveSource.includes(StreamGatherSource.DTMF)) {
      voiceClient.startDtmfGather(mediaSessionRef, (event) => {
        const { digit } = event;
        voiceClient.sendResponse({
          streamGatherPayload: {
            mediaSessionRef,
            digit,
            responseTime: 0
          }
        });
      });
    }

    if (effectiveSource.includes(StreamGatherSource.SPEECH)) {
      voiceClient.startSpeechGather((event) => {
        const { speech, responseTime } = event;
        voiceClient.sendResponse({
          streamGatherPayload: {
            mediaSessionRef,
            speech,
            responseTime
          }
        });
      });
    }

    voiceClient.sendResponse({
      startStreamGatherResponse: {
        mediaSessionRef
      }
    });
  });
}

export { createStreamGatherHandler };
