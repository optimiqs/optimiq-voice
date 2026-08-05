import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const hasSpeechResult = ({
  context
}: {
  context: AutopilotContext;
}): boolean => {
  logger.verbose("called the hasSpeechResult guard", {
    speechBuffer: context.speechBuffer
  });
  return Boolean(context.speechBuffer);
};
