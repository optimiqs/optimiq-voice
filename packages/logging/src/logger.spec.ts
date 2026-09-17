import { beforeEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import {
	AppLogger,
	createPinoLogger,
	getLogger,
	getPinoLogger,
	type PinoLogger,
	setPinoLogger,
} from "./logger";

interface CapturedLine {
	level: string;
	fields: Record<string, unknown>;
	message?: string;
}

interface CapturingLogger {
	logger: PinoLogger;
	lines: CapturedLine[];
	bindings: Record<string, unknown>;
}

function makeCapturingLogger(
	lines: CapturedLine[],
	bindings: Record<string, unknown> = {},
): CapturingLogger {
	const record =
		(level: string) =>
		(fields: Record<string, unknown>, message?: string): void => {
			lines.push({ level, fields, message });
		};

	const logger = {
		trace: record("trace"),
		debug: record("debug"),
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		fatal: record("fatal"),
		child: (childBindings: Record<string, unknown>) =>
			makeCapturingLogger(lines, { ...bindings, ...childBindings }).logger,
	} as unknown as PinoLogger;

	return { logger, lines, bindings };
}

describe("AppLogger", () => {
	let lines: CapturedLine[];
	let logger: AppLogger;

	beforeEach(() => {
		lines = [];
		logger = new AppLogger(makeCapturingLogger(lines).logger, "CallsService");
	});

	it("maps Nest log levels onto pino levels", () => {
		logger.log("started");
		logger.warn("degraded");
		logger.error("failed");
		logger.debug("detail");
		logger.verbose("trace detail");

		expect(lines.map((line) => line.level)).toEqual(["info", "warn", "error", "debug", "trace"]);
	});

	it("attaches the context to every line", () => {
		logger.log("started");
		logger.log("elsewhere", "DialplanService");

		expect(lines[0]?.fields.context).toBe("CallsService");
		expect(lines[1]?.fields.context).toBe("DialplanService");
	});

	it("redacts telephony PII in string messages", () => {
		logger.log("dialing +14155552671 for agent@optimiq.example");

		expect(lines[0]?.message).not.toContain("+14155552671");
		expect(lines[0]?.message).not.toContain("agent@optimiq.example");
		expect(lines[0]?.message).toContain("[REDACTED-PHONE]");
	});

	it("redacts sensitive fields in object messages", () => {
		logger.log({ channelId: "PJSIP/voice-1", fromNumber: "+14155552671", ariSecret: "hunter2" });

		expect(lines[0]?.fields).toMatchObject({
			channelId: "PJSIP/voice-1",
			fromNumber: "[REDACTED]",
			ariSecret: "[REDACTED]",
		});
	});

	it("redacts the message, stack and trace of an error", () => {
		const error = new Error("ARI auth failed for sip://voice:hunter2@203.0.113.10");

		logger.error(error);

		const err = lines[0]?.fields.err as { message: string; stack?: string };
		expect(err.message).not.toContain("hunter2");
		expect(lines[0]?.message).not.toContain("hunter2");

		logger.error("boom", "at +14155552671 (call.ts:1:1)");
		expect(lines[1]?.fields.trace).not.toContain("+14155552671");
	});

	it("derives a scoped logger with withContext without mutating the original", () => {
		const scoped = logger.withContext("RegistryService");

		scoped.log("registered");
		logger.log("original");

		expect(lines[0]?.fields.context).toBe("RegistryService");
		expect(lines[1]?.fields.context).toBe("CallsService");
	});
});

describe("getLogger", () => {
	// Never call the real getPinoLogger() here: it would open a pino transport worker.
	const lines: CapturedLine[] = [];

	beforeEach(() => {
		lines.length = 0;
		setPinoLogger(makeCapturingLogger(lines).logger);
	});

	it("binds the service name onto a plain pino child logger", () => {
		getLogger("ari-worker").info({ event: "connected" }, "ready");

		expect(lines).toHaveLength(1);
		expect(lines[0]?.message).toBe("ready");
	});

	it("returns the logger that was installed process-wide", () => {
		const installed = makeCapturingLogger(lines).logger;
		setPinoLogger(installed);

		expect(getPinoLogger()).toBe(installed);
	});
});

describe("createPinoLogger", () => {
	/** Captures the NDJSON a real pino instance writes, so the hook itself is under test. */
	function makeCapturingPino(): { logger: PinoLogger; lines: Record<string, unknown>[] } {
		const lines: Record<string, unknown>[] = [];
		const destination = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				for (const line of chunk.toString().split("\n").filter(Boolean)) {
					lines.push(JSON.parse(line) as Record<string, unknown>);
				}
				callback();
			},
		});

		return { logger: createPinoLogger({ level: "trace" }, destination), lines };
	}

	it("redacts fields and messages written straight to the pino instance", () => {
		const { logger, lines } = makeCapturingPino();

		logger.error(
			{ dsn: "postgres://svc:hunter2@db.internal:5432/app", sessionId: "sess-1" },
			"call from +14155552671 failed",
		);

		expect(lines).toHaveLength(1);
		const line = lines[0] as { dsn: string; sessionId: string; msg: string };
		expect(line.dsn).toBe("postgres://svc:<REDACTED>@db.internal:5432/app");
		// A correlation key survives; the secret and the E.164 do not.
		expect(line.sessionId).toBe("sess-1");
		expect(line.msg).toBe("call from [REDACTED-PHONE] failed");
	});

	it("blanks sensitive keys nested in a raw pino payload", () => {
		const { logger, lines } = makeCapturingPino();

		logger.info({ headers: { authorization: "Bearer abc123" } }, "upstream call");

		expect(lines[0]?.headers).toEqual({ authorization: "[REDACTED]" });
	});
});
