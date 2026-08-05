import logger from "./logger";
import { ULog } from "./types";

// Special logger function for User specific events
const ulogger = (log: ULog) =>
	logger[log.level](log.message, {
		eventType: log.eventType,
		body: log.body,
		level: log.level,
		accessKeyId: log.accessKeyId,
	});

export { ulogger as default };
