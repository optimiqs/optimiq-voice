import { Inject, Injectable } from "@nestjs/common";
import { OrgLimitsService } from "../org-limits/org-limits.service";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { TRUNK_RESOURCE } from "./trunks.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

@Injectable()
export class TrunksService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(OrgLimitsService) private readonly limits: OrgLimitsService,
	) {
		super(runtime, TRUNK_RESOURCE);
	}

	/**
	 * Refuses the create when the organization is at its trunk quota.
	 *
	 * Here rather than inside the repository's transaction, and `org-limits.service.ts` argues the
	 * trade at length: threading a per-resource precondition through the ONE shared write path would
	 * widen its descriptor for a concept two of thirty resources use. What it costs is a race worth
	 * one overshoot per concurrent request, which is self-correcting and visible in the usage report.
	 */
	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.limits.assertMayCreate(session, "maxTrunks");
		return await super.create(session, values);
	}
}
