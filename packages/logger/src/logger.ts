import winston from "winston";
import { fluent, format, level, transports } from "./envs";

const logger = winston.createLogger({
	levels: winston.config.npm.levels,
	format,
	transports,
	level,
});

logger.on("finish", () => {
	fluent.sender.end("end", {}, () => {});
});

const mute = () => logger.transports.forEach((t) => (t.silent = true));

const unmute = () => logger.transports.forEach((t) => (t.silent = false));

export { logger as default, mute, unmute };
