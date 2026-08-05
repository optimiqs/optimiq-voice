import { randomUUID } from "node:crypto";
import { HttpException, InternalServerErrorException } from "@nestjs/common";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { getPinoLogger } from "@optimiq-voice/logging";
import type { ModuleEffectRuntime } from "./module-runtime";
import type * as Effect from "effect/Effect";

/** A domain error that knows its own HTTP representation. */
interface MappableError {
	toHttpException(): HttpException;
}

function isMappableError(value: unknown): value is MappableError {
	return (
		typeof value === "object" &&
		value !== null &&
		"toHttpException" in value &&
		typeof value.toHttpException === "function"
	);
}

/**
 * The one place Effect meets HTTP. Exactly one `runEffect` per request path — parallel work
 * belongs inside the Effect via `Effect.all`, never as `Promise.all` of several runEffects.
 *
 * Success returns the value. A typed failure is rethrown as an `HttpException`, either
 * directly or via its `toHttpException()`. Anything else is a defect: it is logged in full
 * against an opaque `err_` reference and the caller only ever sees that reference.
 */
export async function runEffect<I, S, E, A, Err>(
	runtime: ModuleEffectRuntime<I, S, E>,
	fn: (svc: S) => Effect.Effect<A, Err, I>,
): Promise<A> {
	const exit = await runtime.runPromiseExit(fn);

	if (Exit.isSuccess(exit)) {
		return exit.value;
	}

	const failure = Cause.findErrorOption(exit.cause);
	if (failure._tag === "Some") {
		const value = failure.value;
		if (value instanceof HttpException) {
			throw value;
		}
		if (isMappableError(value)) {
			throw value.toHttpException();
		}
	}

	const ref = `err_${randomUUID().slice(0, 8)}`;
	getPinoLogger().error({ ref, cause: Cause.pretty(exit.cause) }, "unhandled effect failure");
	throw new InternalServerErrorException({
		statusCode: 500,
		error: "Internal Server Error",
		message: `Unexpected server error. Reference: ${ref}`,
		code: "INTERNAL_ERROR",
	});
}
