import { assign } from "xstate";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const increaseIdleTimeoutCount = assign(({ context }) => {
	logger.verbose("called the increaseIdleTimeoutCount action", {
		idleTimeoutCount: context.idleTimeoutCount + 1,
	});
	context.idleTimeoutCount++;
	return context;
});
