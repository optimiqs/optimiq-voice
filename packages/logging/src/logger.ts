import { Injectable, type LoggerService } from "@nestjs/common";
import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import { env } from "@optimiq-voice/config";
import { redactErrorValue, redactLogValue, scrubSensitiveString } from "./redaction";
import { requireUnknownRecord } from "./unknown-value";

export type { PinoLogger };

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const isProduction = env.NODE_ENV === "production";
const usePrettyLogs = !isProduction && env.LOG_PRETTY !== "false";

const defaultOptions: LoggerOptions = {
	level: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
	base: undefined,
	timestamp: pino.stdTimeFunctions.isoTime,
};

const createDestination = () => {
	if (usePrettyLogs) {
		return pino.transport({
			target: "pino-pretty",
			options: {
				colorize: true,
				translateTime: "SYS:standard",
				singleLine: true,
			},
		});
	}

	return pino.destination({ sync: false });
};

/**
 * The last gate before a transport. It runs on the pino instance itself rather than on any one
 * wrapper, so every front door — `AppLogger`, `getLogger`, the Effect logger bridge, a raw
 * `getPinoLogger().error(...)` on a defect path — is redacted by construction. Redaction is
 * idempotent, so callers that already scrubbed lose nothing by passing through twice.
 */
const redactLogArguments = (args: unknown[]): unknown[] => args.map((arg) => redactLogValue(arg));

export const createPinoLogger = (
	options?: LoggerOptions,
	destination?: pino.DestinationStream,
): PinoLogger => {
	return pino(
		{
			...defaultOptions,
			...options,
			hooks: {
				...options?.hooks,
				logMethod(this: PinoLogger, args: Parameters<PinoLogger["info"]>, method) {
					method.apply(this, redactLogArguments(args) as Parameters<PinoLogger["info"]>);
				},
			},
		},
		destination ?? createDestination(),
	);
};

/**
 * Built lazily: creating the pino destination opens a transport worker, which must not happen
 * merely because a module graph was imported (tests, codegen, CLI `--help` paths).
 */
let sharedLogger: PinoLogger | undefined;

/** The process-wide pino instance. Everything that logs ultimately writes through this. */
export const getPinoLogger = (): PinoLogger => {
	sharedLogger ??= createPinoLogger();
	return sharedLogger;
};

/** Swaps the process-wide logger. Intended for tests and for bootstrap reconfiguration. */
export const setPinoLogger = (logger: PinoLogger): void => {
	sharedLogger = logger;
};

/**
 * Plain, framework-free logger for processes that are not NestJS applications — CLI entry
 * points, migration runners, ARI/NATS workers. `service` is bound to every line.
 */
export const getLogger = (service: string): PinoLogger => {
	return getPinoLogger().child({ service: scrubSensitiveString(service) });
};

const redactLogPayload = (payload: Record<string, unknown>): Record<string, unknown> =>
	requireUnknownRecord(redactLogValue(payload));

/**
 * NestJS `LoggerService` backed by pino. Every message and every field passes through
 * redaction before it reaches a transport — there is no unredacted path out of this class.
 */
@Injectable()
export class AppLogger implements LoggerService {
	private context?: string;

	constructor(
		private readonly logger: PinoLogger = getPinoLogger(),
		context?: string,
	) {
		this.context = context;
	}

	withContext(context: string): AppLogger {
		return new AppLogger(this.logger, context);
	}

	setContext(context: string): void {
		this.context = context;
	}

	log(message: unknown, context?: string): void {
		this.write("info", message, undefined, context);
	}

	error(message: unknown, trace?: string, context?: string): void {
		this.write("error", message, trace, context);
	}

	warn(message: unknown, context?: string): void {
		this.write("warn", message, undefined, context);
	}

	debug(message: unknown, context?: string): void {
		this.write("debug", message, undefined, context);
	}

	verbose(message: unknown, context?: string): void {
		this.write("trace", message, undefined, context);
	}

	private write(level: LogLevel, message: unknown, trace?: string, context?: unknown): void {
		const resolvedContext = context ?? this.context;
		const basePayload: Record<string, unknown> = {};
		if (resolvedContext !== undefined && resolvedContext !== null) {
			basePayload.context = scrubSensitiveString(resolvedContext);
		}
		if (trace) {
			basePayload.trace = scrubSensitiveString(trace);
		}

		if (message instanceof Error) {
			const redactedError = redactErrorValue(message);
			this.logger[level]({ ...basePayload, err: redactedError }, redactedError.message);
			return;
		}

		if (typeof message === "object" && message !== null) {
			const redactedPayload = redactLogPayload(requireUnknownRecord(message));
			this.logger[level]({ ...basePayload, ...redactedPayload });
			return;
		}

		this.logger[level](basePayload, scrubSensitiveString(String(message)));
	}
}
