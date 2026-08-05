import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type PinoLogger, setPinoLogger } from "@optimiq-voice/logging";
import { testDouble } from "../testing/test-double";
import { makeTestModuleRuntime, ModuleEffectRuntime } from "./module-runtime";
import { runEffect } from "./run-effect";

/** Keeps the defect path from opening a real pino transport during the suite. */
const capturedLines: { fields: Record<string, unknown>; message?: string }[] = [];

beforeAll(() => {
	const noop = (fields: Record<string, unknown>, message?: string): void => {
		capturedLines.push({ fields, message });
	};
	setPinoLogger({
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
	} as unknown as PinoLogger);
});

class ChannelNotFoundError {
	readonly _tag = "ChannelNotFoundError";
	toHttpException(): HttpException {
		return new NotFoundException("channel not found");
	}
}

class InvalidDialplanError {
	readonly _tag = "InvalidDialplanError";
	toHttpException(): HttpException {
		return new BadRequestException("invalid dialplan");
	}
}

interface CallsInterface {
	readonly answer: (channelId: string) => Effect.Effect<string>;
	readonly missing: () => Effect.Effect<never, ChannelNotFoundError>;
	readonly invalid: () => Effect.Effect<never, InvalidDialplanError>;
	readonly alreadyHttp: () => Effect.Effect<never, HttpException>;
	readonly opaque: () => Effect.Effect<never, Error>;
	readonly die: () => Effect.Effect<never>;
}

class Calls extends Context.Service<Calls, CallsInterface>()("@optimiq-voice/test/Calls") {}

const CallsLayer = Layer.succeed(
	Calls,
	Calls.of({
		answer: (channelId) => Effect.succeed(`answered:${channelId}`),
		missing: () => Effect.fail(new ChannelNotFoundError()),
		invalid: () => Effect.fail(new InvalidDialplanError()),
		alreadyHttp: () => Effect.fail(new BadRequestException("already mapped")),
		opaque: () => Effect.fail(new Error("provider exploded")),
		die: () => Effect.die(new Error("unexpected defect")),
	}),
);

describe("runEffect boundary", () => {
	let runtime: ModuleEffectRuntime<Calls, CallsInterface, never>;

	beforeEach(() => {
		runtime = makeTestModuleRuntime(Calls, CallsLayer);
	});

	it("returns the success value", async () => {
		expect(await runEffect(runtime, (svc) => svc.answer("PJSIP/voice-1"))).toBe(
			"answered:PJSIP/voice-1",
		);
	});

	it("maps a tagged failure through toHttpException", async () => {
		await expect(runEffect(runtime, (svc) => svc.missing())).rejects.toBeInstanceOf(
			NotFoundException,
		);
		await expect(runEffect(runtime, (svc) => svc.invalid())).rejects.toBeInstanceOf(
			BadRequestException,
		);
	});

	it("rethrows an HttpException failure untouched", async () => {
		try {
			await runEffect(runtime, (svc) => svc.alreadyHttp());
			throw new Error("expected runEffect to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(BadRequestException);
			expect(testDouble(error).getStatus()).toBe(400);
			expect(testDouble(error).message).toBe("already mapped");
		}
	});

	it("maps an unmapped failure to an opaque 500 with an err_ reference", async () => {
		try {
			await runEffect(runtime, (svc) => svc.opaque());
			throw new Error("expected runEffect to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(HttpException);
			expect(testDouble(error).getStatus()).toBe(500);
			expect(testDouble(error).getResponse().message).toContain("Reference: err_");
			// The underlying cause must never reach the caller, only the server log.
			expect(JSON.stringify(testDouble(error).getResponse())).not.toContain("provider exploded");
			const logged = capturedLines.at(-1);
			expect(String(logged?.fields.ref)).toStartWith("err_");
			expect(String(logged?.fields.cause)).toContain("provider exploded");
		}
	});

	it("maps an unexpected defect to a redacted 500", async () => {
		try {
			await runEffect(runtime, (svc) => svc.die());
			throw new Error("expected runEffect to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(HttpException);
			expect(testDouble(error).getStatus()).toBe(500);
			expect(testDouble(error).getResponse().code).toBe("INTERNAL_ERROR");
		}
	});
});
