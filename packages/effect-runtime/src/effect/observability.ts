import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { env } from "@optimiq-voice/config";
import { getPinoLogger } from "@optimiq-voice/logging";
import type * as LogLevel from "effect/LogLevel";

/** Bridges Effect's logging into the platform pino logger so there is a single log stream. */

type PinoLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

function toPinoLevel(level: string): PinoLevel {
	switch (level.toUpperCase()) {
		case "TRACE":
			return "trace";
		case "DEBUG":
			return "debug";
		case "WARN":
			return "warn";
		case "ERROR":
			return "error";
		case "FATAL":
			return "fatal";
		default:
			return "info";
	}
}

function formatMessage(message: unknown): string {
	if (Array.isArray(message)) {
		return message
			.map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
			.join(" ");
	}
	if (typeof message === "string") {
		return message;
	}
	return JSON.stringify(message);
}

const pinoEffectLogger = Logger.map(Logger.formatStructured, (output) => {
	const pino = getPinoLogger();
	const fields: Record<string, unknown> = { ...output.annotations };
	if (Object.keys(output.spans).length > 0) {
		fields.spans = output.spans;
	}
	if (output.cause !== undefined) {
		fields.cause = output.cause;
	}
	pino[toPinoLevel(output.level)](fields, formatMessage(output.message));
});

function levelFromEnv(): LogLevel.LogLevel {
	const raw = (env.EFFECT_OBSERVABILITY_LOG_LEVEL ?? env.LOG_LEVEL ?? "info").toLowerCase();
	const map: Record<string, LogLevel.LogLevel> = {
		trace: "Trace",
		debug: "Debug",
		info: "Info",
		warn: "Warn",
		warning: "Warn",
		error: "Error",
		fatal: "Fatal",
		none: "None",
	};
	return map[raw] ?? "Info";
}

export const Observability = {
	layer: Layer.mergeAll(
		Logger.layer([pinoEffectLogger], { mergeWithExisting: false }),
		Layer.succeed(References.MinimumLogLevel, levelFromEnv()),
	),
};
