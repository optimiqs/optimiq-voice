import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import { cdrCallQuerySchema, cdrLegQuerySchema, cdrListQuerySchema } from "./cdr.dto";
import { CdrService } from "./cdr.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/cdr` — the call-history read surface.
 *
 * ## Why `cdr.read` and not `cdr.read` OR `cdr.read.own`
 *
 * `@RequirePermissions` is an AND: every listed permission must be held. The registry defines both
 * `cdr.read` (every call in the organization) and `cdr.read.own` (only calls the acting user took
 * part in), and `apps/web`'s `PAGE_PERMISSIONS` already lets either one open the page.
 *
 * Only `cdr.read` is enforced here, because `cdr.read.own` is not implementable yet and pretending
 * otherwise would be worse than not offering it: "calls the acting user took part in" requires a
 * user → extension mapping, and `cdr-db` deliberately holds no user ids at all (it stores numbers
 * and entity refs; identity lives in another bounded context). Accepting the permission and
 * returning every row would be a silent privilege escalation; accepting it and returning nothing
 * would be a broken screen. So the narrow grant is not yet honoured by this endpoint, a caller who
 * holds only it gets a 403 naming what is missing, and the self-scoped view is recorded as a
 * follow-up that needs the mapping first.
 *
 * ## Why there is no POST, PATCH or DELETE
 *
 * `call_legs` is an append-only ledger — the tenant role holds SELECT and INSERT and has no UPDATE
 * or DELETE privilege at all. There is no write here to expose, and the only process that adds rows
 * is the durable writer.
 */
@Controller("api/v1/cdr")
export class CdrController {
	constructor(@Inject(CdrService) private readonly cdr: CdrService) {}

	@Get()
	@RequirePermissions("cdr.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.cdr.list(session, parseDto(cdrListQuerySchema, query ?? {}));
	}

	/**
	 * Every leg of one call, before the `:id` route.
	 *
	 * Order matters: Nest matches routes in declaration order, and `calls` would otherwise be
	 * swallowed by `:id` — which, with `ParseUUIDPipe` on it, would turn this into a 400 rather
	 * than a 404 and make the mistake look like a client error.
	 */
	@Get("calls/:callId")
	@RequirePermissions("cdr.read")
	async getCall(
		@Session() session: AppSession,
		@Param("callId", ParseUUIDPipe) callId: string,
		@Query() query: unknown,
	) {
		return await this.cdr.getCall(session, callId, parseDto(cdrCallQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("cdr.read")
	async get(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Query() query: unknown,
	) {
		return await this.cdr.get(session, id, parseDto(cdrLegQuerySchema, query ?? {}));
	}
}
