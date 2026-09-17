import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { hashVoicemailPin } from "../voicemail-boxes/voicemail-pin.service";
import { PIN_SET_ENTRY_RESOURCE, PIN_SET_RESOURCE } from "./pin-sets.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

@Injectable()
export class PinSetsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, PIN_SET_RESOURCE);
	}
}

/**
 * The codes in a set.
 *
 * `setPin` is the only path a digit ever takes into this table, and it goes through the SAME hashing
 * function a mailbox PIN does — `hashVoicemailPin`, whose format `packages/routing`'s
 * `voicemail-pin.ts` defines and whose verifier the engine already carries. That is not tidiness: a
 * second PIN format would be a second parser on the call path and a second thing to get wrong, and
 * the compiler refuses to embed a digest it cannot read, so a format nobody tested would silently
 * leave every gated route ungated.
 *
 * The digest never comes back out. `secretColumns` on the resource strips it from every response,
 * and there is no "show me the code" endpoint — a four-digit PIN behind scrypt is a few CPU-seconds
 * of work once the digest is in hand, which is exactly why upstream's plaintext column was the thing
 * this feature had to change.
 */
@Injectable()
export class PinSetEntriesService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, PIN_SET_ENTRY_RESOURCE);
	}

	/**
	 * Creates a code in one step: the metadata and the digest together.
	 *
	 * A code with no digest is a row the compiler drops with a warning, so a two-step
	 * create-then-set-PIN would leave a window in which the set looks configured and gates nothing.
	 * The generic `create` is therefore not exposed for this collection; this replaces it.
	 */
	async createWithPin(
		session: AppSession,
		pinSetId: string,
		values: Record<string, unknown>,
		pin: string,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		return await this.create(session, pinSetId, {
			...values,
			pinHash: await hashVoicemailPin(pin),
		});
	}

	/** Replaces one code's digits, leaving its ordinal and label — the CDR's identity — alone. */
	async setPin(
		session: AppSession,
		pinSetId: string,
		entryId: string,
		pin: string,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		return await this.update(session, pinSetId, entryId, {
			pinHash: await hashVoicemailPin(pin),
		});
	}
}
