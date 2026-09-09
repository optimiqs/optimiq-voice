import { Inject, Injectable } from "@nestjs/common";
import { eq, trunk } from "@optimiq-voice/pbx-db";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PbxEntityNotFoundFailure } from "../shared/pbx.errors";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { SIP_ACL_ENTRY_RESOURCE } from "./sip-acl.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The generic resource service, plus one thing the generic one cannot know: `trunk_id` has to name
 * a trunk in the WRITER'S organization.
 *
 * The column's foreign key proves the id names a trunk somewhere, and RLS proves the ACL ROW is
 * this tenant's — but an FK check runs as the system and so sees every tenant's trunks. Tenant A
 * could therefore bind an entry to tenant B's trunk id, at which point B deleting that trunk
 * cascades A's allowlist row away. A silent accept is the worst of the three possible answers, so
 * the reference is proved inside the tenant's own scope and an id that is not there is a 404 —
 * the same answer `requireMohClass` gives the media library for the same shape of mistake.
 */
@Injectable()
export class SipAclEntriesService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {
		super(runtime, SIP_ACL_ENTRY_RESOURCE);
	}

	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.assertTrunkInTenant(session, values);
		return await super.create(session, values);
	}

	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.assertTrunkInTenant(session, values);
		return await super.update(session, id, values);
	}

	/**
	 * No-op unless the body actually carries a trunk id: `undefined` leaves the binding alone and
	 * `null` clears it, and neither is a reference to prove.
	 */
	private async assertTrunkInTenant(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<void> {
		const trunkId = values.trunkId;
		if (typeof trunkId !== "string") {
			return;
		}
		const organizationId = this.organizationId(session);
		await this.database.withTenantScope(organizationId, async (transaction) => {
			const found = await transaction
				.select({ id: trunk.id })
				.from(trunk)
				.where(eq(trunk.id, trunkId))
				.limit(1);
			if (found[0] === undefined) {
				throw new PbxEntityNotFoundFailure({ kind: "trunk", id: trunkId }).toHttpException();
			}
		});
	}
}
