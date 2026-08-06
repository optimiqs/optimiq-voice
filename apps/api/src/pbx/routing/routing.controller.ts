import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { simulateRoutingDto } from "./routing.dto";
import { RoutingService } from "./routing.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/routing` — the two operations that are about the compiled artifact rather than about a
 * row.
 *
 * `POST /compile` is a recompile-and-republish; `POST /simulate` is the "what happens if someone
 * calls this DID on Sunday at 3am?" tool `packages/routing`'s README asks for, which costs a
 * controller because the resolvers already take an explicit instant.
 */
@Controller("api/v1/routing")
export class RoutingController {
	constructor(@Inject(RoutingService) private readonly routing: RoutingService) {}

	// Both of these are POSTs because they take a body and are not idempotent-by-URL, but neither
	// creates a resource — Nest's 201 default would be a lie a client could act on.
	@Post("compile")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("routes.publish")
	async compile(@Session() session: AppSession) {
		return { data: await this.routing.compile(session) };
	}

	@Post("simulate")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("routes.simulate")
	async simulate(@Session() session: AppSession, @Body() body: unknown) {
		const request = parseDto(simulateRoutingDto, body);
		return {
			data: await this.routing.simulate(session, request),
		};
	}
}
