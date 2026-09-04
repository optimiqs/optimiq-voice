import { Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { assertOwnsRow, holdsUnscoped, ownedVoicemailBoxIds } from "../shared/self-ownership";
import { VOICEMAIL_BOX_RESOURCE } from "./voicemail-boxes.resource";
import type { ListQuery, PagedResult } from "../shared/pagination";
import type { ItemEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * Voicemail-box configuration.
 *
 * The base class is the org-wide path; the overrides add the `.own` narrowing for the `user` role,
 * whose only mailbox grant that reaches this surface is `voicemail.read.own`. A box is owned through
 * its `extensionId` → `extension_user`, so the `.own` holder sees only the mailboxes of extensions
 * linked to them. An unscoped `voicemail.read` holder takes the base path unchanged.
 */
@Injectable()
export class VoicemailBoxesService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {
		super(runtime, VOICEMAIL_BOX_RESOURCE);
	}

	override async list(
		session: AppSession,
		query: ListQuery,
	): Promise<PagedResult<Record<string, unknown>>> {
		if (holdsUnscoped(session, "voicemail.read")) {
			return await super.list(session, query);
		}
		return await this.listRestricted(session, query, await this.ownedIds(session));
	}

	override async get(
		session: AppSession,
		id: string,
	): Promise<ItemEnvelope<Record<string, unknown>>> {
		const result = await super.get(session, id);
		if (!holdsUnscoped(session, "voicemail.read")) {
			assertOwnsRow(await this.ownedIds(session), id, NOT_YOURS);
		}
		return result;
	}

	private async ownedIds(session: AppSession): Promise<readonly string[]> {
		return await ownedVoicemailBoxIds(this.database, this.organizationId(session), session.user.id);
	}
}

const NOT_YOURS =
	"You hold access to your own voicemail only, and this mailbox is not linked to your account.";
