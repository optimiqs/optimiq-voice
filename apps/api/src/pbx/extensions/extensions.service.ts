import { Inject, Injectable } from "@nestjs/common";
import { OrgLimitsService } from "../org-limits/org-limits.service";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { EXTENSION_RESOURCE } from "./extensions.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/** Extensions CRUD. All logic is in the base class; this binds it to the resource descriptor. */
@Injectable()
export class ExtensionsService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(OrgLimitsService) private readonly limits: OrgLimitsService,
	) {
		super(runtime, EXTENSION_RESOURCE);
	}

	/**
	 * Refuses the create when the organization is at its extension quota.
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
		await this.limits.assertMayCreate(session, "maxExtensions");
		return await super.create(session, values);
	}
}
