import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { getSession } from "./app-session";
import { UnauthenticatedRequestException } from "./auth.errors";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Injects the session resolved by the Fastify `preHandler` hook.
 *
 * Throws 401 when there is none, so a handler annotated with it always receives a real session.
 * Use `@OptionalSession()` for endpoints that serve anonymous callers too.
 */
export const Session = createParamDecorator(
	(_data: unknown, context: ExecutionContext): AppSession => {
		const session = getSession(context.switchToHttp().getRequest<unknown>());
		if (!session) {
			throw new UnauthenticatedRequestException();
		}
		return session;
	},
);

export const OptionalSession = createParamDecorator(
	(_data: unknown, context: ExecutionContext): AppSession | null =>
		getSession(context.switchToHttp().getRequest<unknown>()),
);
