import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const interruptPlayback = async ({
  context
}: {
  context: AutopilotContext;
}) => {
  logger.verbose("called the interruptPlayback action", {
    mediaSessionRef: context.mediaSessionRef
  });
  await context.voice.stopSpeech();
};
