import { Inject, Injectable } from "@nestjs/common";
import { asUuid } from "../../pbx/shared/audit-log";
import { PbxResourceService } from "../../pbx/shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../../pbx/shared/pbx.tokens";
import { AttestationPolicyService } from "../attestation/attestation-policy.service";
import { VERIFIED_CALLER_ID_RESOURCE } from "./caller-ids.resource";
import type { MutationEnvelope } from "../../pbx/shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../../pbx/shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * CRUD over `verified_caller_id`, plus the two things the base class cannot know about.
 *
 * **`verified_by` is stamped from the session**, never from the body — the same derivation
 * `PbxResourceService.actor` makes, for the same reason, and the DTO omits the field so a client
 * cannot try.
 *
 * **Every write invalidates the organization's compiled attestation policy.** Without that, a
 * verification takes effect only when the cache entry ages out, which means a number verified to
 * unblock a customer's outbound calling keeps being attested `C` for up to the TTL — the exact
 * situation somebody would be on the phone about. The dispatcher's cache makes the same seam
 * available (`WebhookDispatcher.invalidate`) for the same class of reason.
 */
@Injectable()
export class VerifiedCallerIdsService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(AttestationPolicyService) private readonly policies: AttestationPolicyService,
	) {
		super(runtime, VERIFIED_CALLER_ID_RESOURCE);
	}

	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const result = await super.create(session, {
			...values,
			verifiedBy: asUuid(this.actor(session).userId),
		});
		this.policies.invalidate(this.organizationId(session));
		return result;
	}

	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		// `verified_by` is NOT re-stamped on an edit. A label fix is not a re-verification, and moving
		// the attributed verifier to whoever last touched the row would quietly rewrite the evidence.
		const result = await super.update(session, id, values);
		this.policies.invalidate(this.organizationId(session));
		return result;
	}

	override async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const result = await super.remove(session, id);
		this.policies.invalidate(this.organizationId(session));
		return result;
	}
}
