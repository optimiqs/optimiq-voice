import { Client } from "ari-client";
import { MuteRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

function createUnmuteHandler(ari: Client, voiceClient: VoiceClient) {
  return withErrorHandling(async (request: MuteRequest) => {
    const { mediaSessionRef, direction } = request;

    await ari.channels.unmute({
      channelId: mediaSessionRef,
      direction
    });

    voiceClient.sendResponse({
      muteResponse: {
        mediaSessionRef
      }
    });
  });
}

export { createUnmuteHandler };
