import {
	Catch,
	type ArgumentsHost,
	type ExceptionFilter,
	type HttpException,
} from "@nestjs/common";
import { MissingActiveOrganizationError, UnauthenticatedSessionError } from "@optimiq-voice/auth";
import { NoActiveOrganizationException, UnauthenticatedRequestException } from "./auth.errors";
import type { FastifyReply } from "fastify";

/**
 * Maps the session errors `@optimiq-voice/auth` throws inside services to the HTTP answers the guard
 * gives for the same conditions.
 *
 * The guard only resolves an active organization on permissioned routes; a session-only route whose
 * service calls `requireActiveOrganizationId` used to surface the raw error as a 500. Registered
 * globally because any org-scoped service can throw it.
 */
@Catch(MissingActiveOrganizationError, UnauthenticatedSessionError)
export class SessionErrorsFilter implements ExceptionFilter<Error> {
	catch(error: Error, host: ArgumentsHost): void {
		const exception: HttpException =
			error instanceof UnauthenticatedSessionError
				? new UnauthenticatedRequestException()
				: new NoActiveOrganizationException();
		const reply = host.switchToHttp().getResponse<FastifyReply>();
		void reply.status(exception.getStatus()).send(exception.getResponse());
	}
}
