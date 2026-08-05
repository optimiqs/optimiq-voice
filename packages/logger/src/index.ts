import { getLogger } from "./getLogger";
import logger, { mute, unmute } from "./logger";
import { ULogType } from "./types";
import ulogger from "./userLogger";

export { ULogType, logger as default, getLogger, mute, ulogger, unmute };
