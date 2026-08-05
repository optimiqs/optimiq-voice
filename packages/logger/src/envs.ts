import fluentLogger from "fluent-logger";
import winston from "winston";
import { getEnv } from "./getEnv";

const FluentTransport = fluentLogger.support.winstonTransport();

const LOGS_DRIVER_HOST = getEnv("LOGS_DRIVER_HOST");
// Note: if LOGS_DRIVER_PORT is provided as a string in the environment, it will be used as-is.
const LOGS_DRIVER_PORT = getEnv("LOGS_DRIVER_PORT", 24224);
const LOGS_OPT_TAG_PREFIX = getEnv("LOGS_OPT_TAG_PREFIX", "optimiq-voice-logs");
const LOGS_FORMAT = getEnv("LOGS_FORMAT", "json");
const LOGS_LEVEL = getEnv("LOGS_LEVEL", "info");
const LOGS_TRANSPORT = getEnv<"console" | "fluent">("LOGS_TRANSPORT", "console");

const fluent = new FluentTransport(`${LOGS_OPT_TAG_PREFIX}`, {
	host: LOGS_DRIVER_HOST,
	port: LOGS_DRIVER_PORT,
	timeout: 3.0,
	requireAckResponse: false,
});

const format =
	LOGS_FORMAT === "json"
		? winston.format.combine(winston.format.timestamp(), winston.format.json())
		: winston.format.combine(winston.format.colorize(), winston.format.simple());

const transports = LOGS_TRANSPORT === "fluent" ? [fluent] : [new winston.transports.Console()];

export { fluent, format, LOGS_LEVEL as level, transports };
