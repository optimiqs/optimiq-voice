import { assign } from "xstate";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const resetIdleTimeoutCount = assign(({ context }) => {
  logger.verbose("called the resetIdleTimeoutCount action", {
    idleTimeoutCount: 0
  });
  context.idleTimeoutCount = 0;
  return context;
});
