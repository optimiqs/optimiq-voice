import { Inject, Injectable } from "@nestjs/common";
import { OrgLimitsService } from "../org-limits/org-limits.service";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import {
	assertOwnsRow,
	holdsUnscoped,
	ownedExtensionIds,
	SelfServiceScopeForbiddenException,
} from "../shared/self-ownership";
import { EXTENSION_RESOURCE } from "./extensions.resource";
import type { ListQuery, PagedResult } from "../shared/pagination";
import type { ItemEnvelope, MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The fields an `extensions.write.own` holder may change on THEIR OWN extension.
 *
 * The `.own` grant's description is precise — "forwarding, do-not-disturb and follow-me" — and the
 * limit is not cosmetic: `tollClass` gates which outbound routes an extension may take, so a user
 * who could raise their own would hold a self-service toll-fraud lever. The generic write path has
 * no per-column permission concept (deliberately — see `permissionEnforcement.test.ts`), so the
 * allowlist is applied HERE, before delegating: a `.own` write that names any other column is
 * refused rather than silently stripped, so the caller learns their role's edge instead of
 * wondering why a field did not save. An UNSCOPED `extensions.write` holder bypasses this entirely.
 */
const SELF_EDITABLE_EXTENSION_FIELDS: ReadonlySet<string> = new Set<string>([
	"forwardAllEnabled",
	"forwardAllDestination",
	"forwardBusyEnabled",
	"forwardBusyDestination",
	"forwardNoAnswerEnabled",
	"forwardNoAnswerDestination",
	"forwardUnregisteredEnabled",
	"forwardUnregisteredDestination",
	"followMe",
	"doNotDisturb",
]);

/**
 * Extensions CRUD.
 *
 * The base class carries the org-wide path; the overrides add the `.own` narrowing for the `user`
 * role, whose only extension grants are `extensions.read.own` / `extensions.write.own`. An unscoped
 * holder (`manager`, `admin`) satisfies the scoped guard by the substitution rule and takes the base
 * path unchanged; a `.own`-only holder is narrowed to the extensions they are linked to through
 * `extension_user`.
 */
@Injectable()
export class ExtensionsService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(OrgLimitsService) private readonly limits: OrgLimitsService,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {
		super(runtime, EXTENSION_RESOURCE);
	}

	override async list(
		session: AppSession,
		query: ListQuery,
	): Promise<PagedResult<Record<string, unknown>>> {
		if (holdsUnscoped(session, "extensions.read")) {
			return await super.list(session, query);
		}
		return await this.listRestricted(session, query, await this.ownedIds(session));
	}

	override async get(
		session: AppSession,
		id: string,
	): Promise<ItemEnvelope<Record<string, unknown>>> {
		const result = await super.get(session, id);
		if (!holdsUnscoped(session, "extensions.read")) {
			assertOwnsRow(await this.ownedIds(session), id, NOT_YOURS);
		}
		return result;
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

	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		if (!holdsUnscoped(session, "extensions.write")) {
			assertOwnsRow(await this.ownedIds(session), id, NOT_YOURS);
			this.assertSelfEditable(values);
		}
		return await super.update(session, id, values);
	}

	private async ownedIds(session: AppSession): Promise<readonly string[]> {
		return await ownedExtensionIds(this.database, this.organizationId(session), session.user.id);
	}

	private assertSelfEditable(values: Record<string, unknown>): void {
		const disallowed = Object.keys(values).filter(
			(key) => !SELF_EDITABLE_EXTENSION_FIELDS.has(key),
		);
		if (disallowed.length > 0) {
			throw new SelfServiceScopeForbiddenException(
				`Your role may only change forwarding, do-not-disturb and follow-me on your own ` +
					`extension. It cannot change: ${disallowed.join(", ")}.`,
			);
		}
	}
}

const NOT_YOURS =
	"You hold access to your own extensions only, and this extension is not linked to your account.";
