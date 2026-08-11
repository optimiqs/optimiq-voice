import { Controller, Get, Inject, Query } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { SipAuthEventQueryService } from "./sip-auth-event-query.service";
import { sipAuthEventQuerySchema } from "./sip-auth-event.dto";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/sip-auth-events` — the attack log.
 *
 * The read half of the surface the parity audit's row 1.25 says the platform has none of. Read
 * only, and there is no write endpoint for the same reason `/api/v1/audit-log` has none: the table
 * is append-only in the database itself, so no HTTP verb could be implemented from this process
 * even if someone wrote one. The writers are `SipAuthEventService`, called by the surfaces that
 * refuse a request, and — once the shipper lands — the media server's security log.
 *
 * There is no `GET /:id`: an event IS its detail, and every column is on the list row.
 */
@Controller("api/v1/sip-auth-events")
export class SipAuthEventController {
	constructor(
		@Inject(SipAuthEventQueryService) private readonly events: SipAuthEventQueryService,
	) {}

	@Get()
	@RequirePermissions("security.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.events.list(session, parseDto(sipAuthEventQuerySchema, query ?? {}));
	}
}
