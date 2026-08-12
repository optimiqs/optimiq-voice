import { Body, Controller, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { emptyConferenceModerationDto, setConferenceVolumeDto } from "./conference-moderation.dto";
import { ConferenceModerationService } from "./conference-moderation.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/conferences/:id/…` — the LIVE room, as opposed to the row.
 *
 * ## Why it is a separate controller from the CRUD
 *
 * `ConferencesController` edits a `conference` ROW: a name, a cap, a recording policy, a PIN. Nothing
 * it does affects a meeting that is already running. Every route here acts on a meeting and nothing
 * on the row — a mute is gone when the participant hangs up, and a lock is gone when the room
 * empties.
 *
 * They are also guarded differently, which is the harder reason: `conferences.moderate` must NOT
 * guard the CRUD, because muting somebody for a minute and re-pointing the room's recording policy
 * forever are different powers. Two controllers make that impossible to get wrong by adding a route
 * to the wrong file; one controller with two decorators would make it a matter of remembering.
 *
 * ## The ACTION is in the path, not in the body
 *
 * `POST /:id/participants/:ref/mute` and not `PATCH /:id/participants/:ref { muted: true }`, on the
 * `queue-agent-session` precedent and for the same two reasons. A path verb has exactly one target,
 * so there is no request that can name a state the server would have to reason about after the fact;
 * and a body that sometimes contains a state is a body a client can half-fill. It is also what makes
 * the audit trail readable — "POST …/kick" is what happened, where a PATCH is a diff.
 *
 * ## `:ref` is a LEG id, not a media channel id
 *
 * The identifier `conference.joined` publishes, which is the only one the control plane ever sees. A
 * media channel id is the engine's private handle onto a media server; it changes when the driver
 * changes, and a URL carrying one would put an Asterisk-ism in a REST path. It is deliberately NOT
 * `ParseUUIDPipe`'d: a leg id is a UUID on this platform today and the engine treats it as an opaque
 * token, so validating its shape here would be this controller having an opinion about somebody
 * else's identifier format.
 *
 * ## Permissions
 *
 * Every route declares `conferences.read` and the real decision is made in the service against
 * `conferences.moderate`. See `conference-moderation.service.ts` for why that split produces a
 * better 403 than putting the grant on the decorator.
 */
@Controller("api/v1/conferences")
export class ConferenceModerationController {
	constructor(
		@Inject(ConferenceModerationService)
		private readonly moderation: ConferenceModerationService,
	) {}

	/** The room stops hearing this participant. What `*6` does from the handset. */
	@Post(":id/participants/:ref/mute")
	@RequirePermissions("conferences.read")
	async mute(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ref") ref: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "mute", { memberRef: ref });
	}

	@Post(":id/participants/:ref/unmute")
	@RequirePermissions("conferences.read")
	async unmute(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ref") ref: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "unmute", { memberRef: ref });
	}

	/**
	 * This participant stops hearing the room. Their own audio still reaches it unless also muted.
	 *
	 * A separate verb from `mute` rather than a direction on it, because they are different acts: one
	 * takes somebody's voice out of the meeting and the other takes the meeting away from them.
	 */
	@Post(":id/participants/:ref/deaf")
	@RequirePermissions("conferences.read")
	async deaf(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ref") ref: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "deaf", { memberRef: ref });
	}

	@Post(":id/participants/:ref/undeaf")
	@RequirePermissions("conferences.read")
	async undeaf(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ref") ref: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "undeaf", { memberRef: ref });
	}

	/**
	 * Removes the participant from the meeting.
	 *
	 * It does not, on its own, hang their call up — the engine takes them out of the bridge and then
	 * ends the leg, and the two are separate steps for a reason worth keeping: a kicked participant
	 * is out of the meeting and still on a call the platform could route somewhere, and a release
	 * with a "removed participants hear this" destination would change only the second half.
	 */
	@Post(":id/participants/:ref/kick")
	@RequirePermissions("conferences.read")
	async kick(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ref") ref: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "kick", { memberRef: ref });
	}

	/**
	 * Re-levels a participant — and is REFUSED with a 501 on every media plane this platform runs.
	 *
	 * The route exists anyway, and that is a deliberate copy of the argument
	 * `rpc.media.v1.tap-session` made when it shipped before its responder: a declared-and-refused
	 * action gives an operator a reason naming what is missing, where a 404 reads as "this product
	 * does not have volume control" and sends them to a competitor's feature list.
	 *
	 * What is actually missing is a WIRE, not a feature. Asterisk has no per-participant gain on a
	 * mixing bridge at all; `apps/mediad`'s mixer has `Member.SetGain`, atomic and applied on every
	 * frame, with no command that reaches it. See the coverage map on `MediadMediaPort`.
	 */
	@Post(":id/participants/:ref/volume")
	@RequirePermissions("conferences.read")
	async volume(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ref") ref: string,
		@Body() body: unknown,
	) {
		const { gainPercent, scope } = parseDto(setConferenceVolumeDto, body);
		return await this.moderation.moderate(session, id, "volume", {
			memberRef: ref,
			gainPercent,
			...(scope === undefined ? {} : { gainScope: scope }),
		});
	}

	/**
	 * The room stops admitting new participants.
	 *
	 * Not the same as a room at its member cap, even though a caller hears a refusal either way: a
	 * full room admits the next arrival the moment somebody leaves, and a locked one does not admit
	 * anybody until it is unlocked. They get different announcements for exactly that reason.
	 */
	@Post(":id/lock")
	@RequirePermissions("conferences.read")
	async lock(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "lock");
	}

	@Post(":id/unlock")
	@RequirePermissions("conferences.read")
	async unlock(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyConferenceModerationDto, body ?? {});
		return await this.moderation.moderate(session, id, "unlock");
	}
}
