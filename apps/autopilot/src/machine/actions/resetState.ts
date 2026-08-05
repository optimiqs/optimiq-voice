import { assign } from "xstate";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const resetState = assign(({ context }) => {
	logger.verbose("called the resetState action");
	return {
		...context,
		speechBuffer: "",
		idleTimeoutCount: 0,
	};
});
