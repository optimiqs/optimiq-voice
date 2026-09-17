import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import * as Effect from "effect/Effect";
import { createPinoLogger, type PinoLogger, setPinoLogger } from "@optimiq-voice/logging";
import { Observability } from "./observability";

/**
 * Both Effect front doors — `Effect.log` annotations and the `Cause` a defect carries — reach
 * pino directly rather than through `AppLogger`. Redaction therefore has to live on the pino
 * instance itself; these tests are what proves it does.
 */
function installCapturingPino(): Record<string, unknown>[] {
	const lines: Record<string, unknown>[] = [];
	const destination = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			for (const line of chunk.toString().split("\n").filter(Boolean)) {
				lines.push(JSON.parse(line) as Record<string, unknown>);
			}
			callback();
		},
	});
	setPinoLogger(createPinoLogger({ level: "trace" }, destination) as PinoLogger);
	return lines;
}

describe("Observability", () => {
	it("redacts annotations and message parts written through Effect.log", async () => {
		const lines = installCapturingPino();

		await Effect.runPromise(
			Effect.logInfo("registration for +14155552671 rejected").pipe(
				Effect.annotateLogs({
					sessionId: "sess-1",
					sipPassword: "s3cr3t",
					dsn: "postgres://svc:hunter2@db.internal:5432/app",
				}),
				Effect.provide(Observability.layer),
			),
		);

		expect(lines).toHaveLength(1);
		const line = lines[0] as {
			msg: string;
			sessionId: string;
			sipPassword: string;
			dsn: string;
		};
		expect(line.msg).toBe("registration for [REDACTED-PHONE] rejected");
		expect(line.sessionId).toBe("sess-1");
		expect(line.sipPassword).toBe("[REDACTED]");
		expect(line.dsn).toBe("postgres://svc:<REDACTED>@db.internal:5432/app");
	});

	it("redacts the rendered cause of a failed effect", async () => {
		const lines = installCapturingPino();

		await Effect.runPromise(
			Effect.fail(
				new Error("connect postgres://svc:hunter2@db.internal:5432/app for +14155552671"),
			).pipe(
				Effect.catchCause((cause) => Effect.logError("boom", cause)),
				Effect.provide(Observability.layer),
			),
		);

		const cause = String((lines[0] as { cause?: unknown }).cause);
		expect(cause).not.toContain("hunter2");
		expect(cause).not.toContain("+14155552671");
		expect(cause).toContain("<REDACTED>");
	});
});
