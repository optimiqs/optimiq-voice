import winston from "winston";
import { fluent, level, transports } from "./envs";

const loggers = new Map();

function getLogger(config: { service?: string; filePath: string }) {
	const key = config.service || "default";

	if (loggers.has(key)) {
		return loggers.get(key);
	}

	const humanFormat = winston.format.combine(
		winston.format.timestamp({
			format: "YYYY-MM-dd HH:mm:ss.SSS",
		}),
		winston.format.printf(
			({ level, message, timestamp, ...metadata }) =>
				`${timestamp} [${level}]: ${
					config.service ? `(${config.service})` : ""
				} ${message} ${JSON.stringify(metadata)}`,
		),
	);

	const newLogger = winston.createLogger({
		levels: winston.config.npm.levels,
		format: humanFormat,
		transports,
		level,
	});

	newLogger.on("finish", () => {
		fluent.sender.end("end", {}, () => {});
	});

	loggers.set(key, newLogger);

	return newLogger;
}

export { getLogger };
