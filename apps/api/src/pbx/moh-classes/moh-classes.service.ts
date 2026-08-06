import { Inject, Injectable } from "@nestjs/common";
import { PromptsService } from "../prompts/prompts.service";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { MOH_CLASS_RESOURCE } from "./moh-classes.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Music-on-hold classes.
 *
 * A plain `PbxResourceService` in every respect but one: {@link remove} unlinks the class's audio,
 * because `prompt.moh_class_id` is `on delete cascade` and the rows go with the class while the
 * objects do not.
 */
@Injectable()
export class MohClassesService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PromptsService) private readonly prompts: PromptsService,
	) {
		super(runtime, MOH_CLASS_RESOURCE);
	}

	/**
	 * Deletes a class, and unlinks the files under it.
	 *
	 * ```text
	 * read the file object keys        (nothing has changed yet)
	 * repository.remove                (guard -> 409, or delete; the prompt ROWS cascade)
	 * unlink the objects               (best effort, after the commit)
	 * ```
	 *
	 * The keys are read FIRST because after the delete nothing names them — the cascade takes the
	 * rows and leaves the files. The unlink happens LAST because a filesystem operation cannot
	 * participate in a Postgres transaction, so one failure window has to exist and this is the
	 * inert one: an object with no row is unreachable, whereas a class deleted after its files were
	 * unlinked but before the row went would be a class whose hold music is silence.
	 *
	 * A class that something still points at is answered `409` by the guard inside
	 * `repository.remove`, and by then nothing has been unlinked — which is the whole reason the
	 * unlink is not first. Five foreign keys point here (`extension`, `ring_group`, `queue`,
	 * `conference`, `park_lot`), all of them `on delete set null`; see `moh-classes.resource.ts`
	 * for why they are refused rather than nulled.
	 */
	override async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = this.organizationId(session);
		const objectKeys = await this.prompts.readMohClassObjectKeys(organizationId, id);
		const result = await super.remove(session, id);
		await this.prompts.unlinkObjects(objectKeys, `moh-class ${id} deleted`);
		return result;
	}
}
