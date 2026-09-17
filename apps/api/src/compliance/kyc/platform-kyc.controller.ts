import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import { kycDecisionDto, platformKycListQuerySchema } from "./kyc.dto";
import { PlatformKycService } from "./platform-kyc.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/platform/compliance/kyc` — the operator's review queue.
 *
 * | Route                        | Permission           |
 * | ---------------------------- | -------------------- |
 * | `GET`                        | `compliance.review`  |
 * | `POST /:organizationId/decision` | `compliance.review` |
 *
 * ## The `/platform/` prefix is load-bearing
 *
 * Every other route in this API is answered inside the caller's active organization. These two are
 * not — they read and write across tenants — and the path says so, so that a reader of the route
 * table can find every cross-tenant surface by grepping for one segment rather than by knowing which
 * permissions happen to be in `OWNER_ONLY_PERMISSIONS`. `compliance.review` is the guard; the prefix
 * is the documentation, and the two must never disagree.
 *
 * ## Why the decision is a `POST` to a sub-resource rather than a `PATCH` of the file
 *
 * A verdict is an EVENT — "a reviewer decided this, at this instant, with these notes" — and the
 * columns it writes are not columns anyone edits. `PATCH /kyc/:id { decision }` would put the
 * reviewer's write and the tenant's write on the same route shape, which is the shape the whole
 * separation of `upsertKycDto` from `kycDecisionDto` exists to prevent.
 */
@Controller("api/v1/platform/compliance/kyc")
export class PlatformKycController {
	constructor(@Inject(PlatformKycService) private readonly review: PlatformKycService) {}

	@Get()
	@RequirePermissions("compliance.review")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.review.list(session, parseDto(platformKycListQuerySchema, query ?? {}));
	}

	@Post(":organizationId/decision")
	@RequirePermissions("compliance.review")
	async decide(
		@Session() session: AppSession,
		@Param("organizationId", ParseUUIDPipe) organizationId: string,
		@Body() body: unknown,
	) {
		return await this.review.decide(session, organizationId, parseDto(kycDecisionDto, body));
	}
}
