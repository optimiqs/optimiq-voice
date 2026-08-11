import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { originateCallDto } from "./calls.dto";
import { CallsService } from "./calls.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/calls`.
 *
 * One route, and `201` rather than Nest's default because a call is a resource this request brought
 * into existence — the body names it, and the id is what every webhook about it will carry.
 *
 * There is deliberately no `GET /api/v1/calls`, and no `DELETE /api/v1/calls/:id`. Live call state
 * is served by the live channel (`live-topics.ts`, `active-calls`) and the history by
 * `/api/v1/cdr`; a third view of the same facts would be a third thing to keep consistent.
 * Hanging a call up is a mid-call control operation the engine does not expose over HTTP at all yet
 * — see the `calls.originate` registry entry for why no permission was minted for it either.
 */
@Controller("api/v1/calls")
export class CallsController {
	constructor(@Inject(CallsService) private readonly calls: CallsService) {}

	@Post()
	@HttpCode(HttpStatus.CREATED)
	@RequirePermissions("calls.originate")
	async originate(@Session() session: AppSession, @Body() body: unknown) {
		const request = parseDto(originateCallDto, body);
		return { data: await this.calls.originate(session, request) };
	}
}
