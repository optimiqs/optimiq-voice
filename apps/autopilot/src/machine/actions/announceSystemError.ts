import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const announceSystemError = async ({
  context
}: {
  context: AutopilotContext;
}) => {
  logger.verbose("called the announceSystemError action", {
    systemErrorMessage: context.systemErrorMessage
  });
  await context.voice.say(context.systemErrorMessage);
};
