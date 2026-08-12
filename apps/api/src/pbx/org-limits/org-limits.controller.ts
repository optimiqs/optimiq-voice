import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { writeOrgLimitsDto } from "./org-limits.dto";
import { OrgLimitsService } from "./org-limits.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/org-limits` — a singleton, not a collection.
 *
 * There is exactly one row per organization and it is reached without an id, because an id would be
 * a detail of this table that every caller would have to fetch before it could write. `PUT` rather
 * than `PATCH` for the write is deliberate too: the body is the complete set of ceilings, and a
 * partial one would make "remove this limit" and "leave this limit alone" the same request.
 *
 * The two grants are deliberately far apart. `org-limits.read` is wide — a manager fielding "why did
 * creating an extension fail" needs the answer — and `org-limits.write` is held by `owner` ALONE and
 * is excluded from `ADMIN_PERMISSIONS`, because a quota an administrator can raise is not a quota.
 * That is not a real control-plane boundary and does not pretend to be one; it is the narrowest this
 * model can express until the reseller hierarchy (W14) gives limits a platform-operator home.
 */
@Controller("api/v1/org-limits")
export class OrgLimitsController {
	constructor(@Inject(OrgLimitsService) private readonly limits: OrgLimitsService) {}

	@Get()
	@RequirePermissions("org-limits.read")
	async read(@Session() session: AppSession) {
		return await this.limits.read(session);
	}

	@Put()
	@RequirePermissions("org-limits.write")
	async write(@Session() session: AppSession, @Body() body: unknown) {
		return await this.limits.write(session, parseDto(writeOrgLimitsDto, body));
	}

	/**
	 * What the organization is using, against what it may.
	 *
	 * Under `read` rather than under a grant of its own: usage without limits is a statistic nobody
	 * asked for, and limits without usage is a number nobody can act on. They are one screen.
	 */
	@Get("usage")
	@RequirePermissions("org-limits.read")
	async usage(@Session() session: AppSession) {
		return { data: await this.limits.usage(session) };
	}
}
