import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import { upsertKycDto } from "./kyc.dto";
import { ComplianceKycService } from "./kyc.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/compliance/kyc` — the tenant's own know-your-customer file.
 *
 * | Route | Permission          |
 * | ----- | ------------------- |
 * | `GET` | `compliance.read`   |
 * | `PUT` | `compliance.write`  |
 *
 * ## `PUT` and not `POST`/`PATCH`, and the reason is the unique index
 *
 * `organization_kyc_organization_key` makes this a table with at most one row per tenant, which is
 * a SINGLETON and not a collection — there is no id to POST to and nothing to enumerate. `PUT` says
 * "here is the file", which is what the onboarding form does, and it makes the amendment rule
 * legible: a `PUT` replaces the statement, and replacing a statement a reviewer accepted un-accepts
 * it. See `kyc.rules.ts`.
 *
 * A `PATCH` would invite the opposite reading — that a one-field correction is not really an
 * amendment — which is precisely the loophole the reset rule exists to close.
 */
@Controller("api/v1/compliance/kyc")
export class ComplianceKycController {
	constructor(@Inject(ComplianceKycService) private readonly kyc: ComplianceKycService) {}

	@Get()
	@RequirePermissions("compliance.read")
	async get(@Session() session: AppSession) {
		return await this.kyc.get(session);
	}

	@Put()
	@RequirePermissions("compliance.write")
	async put(@Session() session: AppSession, @Body() body: unknown) {
		return await this.kyc.upsert(session, parseDto(upsertKycDto, body));
	}
}
