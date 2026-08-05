import { Client } from "ari-client";
import { VerbRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

function createHangupHandler(ari: Client, voiceClient: VoiceClient) {
  return withErrorHandling(async (request: VerbRequest) => {
    const { mediaSessionRef } = request;

    // Give some time for the last sound to play
    setTimeout(() => {
      ari.channels.hangup({ channelId: mediaSessionRef });

      voiceClient.sendResponse({
        hangupResponse: {
          mediaSessionRef
        }
      });

      voiceClient.close();
    }, 2000);
  });
}

export { createHangupHandler };
