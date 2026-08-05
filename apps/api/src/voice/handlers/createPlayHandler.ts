import { Client } from "ari-client";
import { nanoid } from "nanoid";
import { PlayRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { awaitForPlaybackFinished } from "./utils/awaitForPlaybackFinished";
import { withErrorHandling } from "./utils/withErrorHandling";

function createPlayHandler(ari: Client, voiceClient: VoiceClient) {
  return withErrorHandling(async (request: PlayRequest) => {
    const { mediaSessionRef } = request;

    const playbackRef = request.playbackRef || nanoid(10);

    await ari.channels.play({
      channelId: mediaSessionRef,
      media: `sound:${request.url}`,
      playbackId: playbackRef
    });

    await awaitForPlaybackFinished(ari, playbackRef);

    voiceClient.sendResponse({
      playResponse: {
        mediaSessionRef,
        playbackRef
      }
    });
  });
}

export { createPlayHandler };
