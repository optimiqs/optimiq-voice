import { Controller, Get, Inject, Query } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import { attestationSummaryQuerySchema } from "./attestation-summary";
import { AttestationSummaryService } from "./attestation-summary.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/compliance/attestation-summary` — what this tenant presented, and how well.
 *
 * `compliance.read`, the same permission that reads the KYC file and the verified caller ids, because
 * it is the same screen: a compliance page that lists the numbers with no right-to-use record next to
 * the form for filing one. A separate permission would only make it possible to build half of that
 * page.
 */
@Controller("api/v1/compliance/attestation-summary")
export class AttestationSummaryController {
	constructor(
		@Inject(AttestationSummaryService) private readonly summary: AttestationSummaryService,
	) {}

	@Get()
	@RequirePermissions("compliance.read")
	async get(@Session() session: AppSession, @Query() query: unknown) {
		return await this.summary.summary(
			session,
			parseDto(attestationSummaryQuerySchema, query ?? {}),
		);
	}
}
