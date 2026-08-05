import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const idleTimeoutCountExceedsMax = ({
  context
}: {
  context: AutopilotContext;
}): boolean => {
  logger.verbose("called the idleTimeoutCountExceedsMax guard", {
    idleTimeoutCount: context.idleTimeoutCount + 1,
    maxIdleTimeoutCount: context.maxIdleTimeoutCount
  });
  return context.idleTimeoutCount + 1 > context.maxIdleTimeoutCount;
};
