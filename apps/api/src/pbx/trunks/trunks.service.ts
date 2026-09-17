import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { OrgLimitsService } from "../org-limits/org-limits.service";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { TRUNK_RESOURCE } from "./trunks.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * A registering trunk with no credential is a row nothing can ever load.
 *
 * `kind: "register"` means sipd sends REGISTER with a digest credential, and its own ingest
 * refuses a gateway without an auth user — permanently, on every reload, keeping the previous
 * configuration and logging `ignoring an invalid trunk record`. Ten such rows were found on the
 * live stack: the API had accepted writes the SIP edge can never act on, so the tenant sees a
 * trunk in the list that does not exist as far as calls are concerned.
 *
 * So the refusal moves to admission. `sipSecretRef` is required alongside the username for the
 * same reason — a username without the secret's address authenticates nothing, and the
 * registration would fail at the carrier instead of at the form.
 *
 * `kind` defaults to `register` in the schema, so an absent `kind` on a create is a registering
 * trunk and is checked as one.
 */
function registrationIssue(row: {
	readonly kind?: unknown;
	readonly authUser?: unknown;
	readonly sipSecretRef?: unknown;
}): { readonly field: string; readonly message: string } | undefined {
	if ((row.kind ?? "register") !== "register") {
		return undefined;
	}
	if (typeof row.authUser !== "string" || row.authUser.trim() === "") {
		return {
			field: "authUser",
			message:
				"A trunk that registers needs a SIP username: the SIP edge refuses a registering " +
				"gateway without one, so the trunk would never come up.",
		};
	}
	if (typeof row.sipSecretRef !== "string" || row.sipSecretRef.trim() === "") {
		return {
			field: "sipSecretRef",
			message:
				"A trunk that registers needs a secret reference: the username alone authenticates " +
				"nothing at the carrier.",
		};
	}
	return undefined;
}

function refuseRegistration(issue: { readonly field: string; readonly message: string }): never {
	throw new HttpException(
		{
			statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
			code: "PBX_INVALID_TRUNK_REGISTRATION",
			message: issue.message,
			field: issue.field,
			issues: [issue],
		},
		HttpStatus.UNPROCESSABLE_ENTITY,
	);
}

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
		const issue = registrationIssue(values);
		if (issue !== undefined) {
			refuseRegistration(issue);
		}
		await this.limits.assertMayCreate(session, "maxTrunks");
		return await super.create(session, values);
	}

	/**
	 * The same admission check, against the row as it WILL be.
	 *
	 * A PATCH that only flips `kind` to `register`, or only clears `authUser`, produces exactly the
	 * un-loadable row the create path now refuses, so the stored row is read first and the patch
	 * merged over it. The read is unredacted on purpose — {@link PbxResourceService.get} strips
	 * `sipSecretRef`, and a check run against the redacted shape would refuse every update of an
	 * already-valid trunk.
	 */
	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		const current = await runEffect(this.runtime, (repository) =>
			repository.get(organizationId, this.resource, id),
		);
		const issue = registrationIssue({ ...current, ...values });
		if (issue !== undefined) {
			refuseRegistration(issue);
		}
		return await super.update(session, id, values);
	}
}
