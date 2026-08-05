import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const goodbye = async ({ context }: { context: AutopilotContext }) => {
  logger.verbose("called the goodbye action", {
    goodbyeMessage: context.goodbyeMessage
  });
  await context.voice.say(context.goodbyeMessage);
  await context.voice.hangup();
};
