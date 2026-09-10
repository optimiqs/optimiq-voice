import {
	Body,
	Controller,
	Delete,
	Get,
	Header,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
	Req,
	Res,
} from "@nestjs/common";
import { PublicRoute } from "../../auth/public-route.decorator";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { applyMediaResponse, readRangeHeader } from "../../media/media-http";
import { parseDto } from "../shared/dto";
import {
	deleteVoicemailMessageQuerySchema,
	forwardVoicemailMessageDto,
	updateVoicemailMessageDto,
	voicemailMessageListQuerySchema,
} from "./voicemail-messages.dto";
import { VoicemailMessagesService } from "./voicemail-messages.service";
import type { MediaReply, MediaRequest } from "../../media/media-http";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/voicemail-boxes/:id/messages` — the mailbox's contents.
 *
 * A separate controller from `voicemail-boxes.controller.ts` on purpose: that one is the box's
 * CONFIGURATION (a routing entity, edited through the Effect repository, recompiled on save) and
 * this one is its CONTENTS (not a routing input at all — `affectsRouting("voicemail_message")` is
 * false). They share a URL prefix because that is the resource tree; they share nothing else, and
 * putting them in one class would hide that.
 *
 * ## The permissions, and why they are the ones they are
 *
 * | Route                          | Permission             | Reasoning                            |
 * | ------------------------------ | ---------------------- | ------------------------------------ |
 * | `GET …/messages`               | `voicemail.read.own`   | Seeing what is in a mailbox          |
 * | `PATCH …/messages/:id`         | `voicemail.write.own`  | Changing a mailbox's state           |
 * | `DELETE …/messages/:id`        | `voicemail.delete.own` | The registry already separates it from write |
 * | `POST …/messages/:id/play-url` | `voicemail.listen.own` | Seeing that a message exists and LISTENING to it are different decisions |
 * | `POST …/messages/:id/forward`  | `voicemail.write.own`  | Sending a message on is a change to the mailbox it leaves, and to the one it lands in |
 *
 * The `.own` variants are the FLOOR, not a narrowing: `hasPermission` lets the unscoped grant
 * satisfy a scoped requirement, so a manager holding `voicemail.read` still passes, while a
 * self-service `user` reaches only the boxes linked to their own extension —
 * `VoicemailMessagesService.assertMayReachBox` is the row half of it.
 *
 * `PATCH` was the hole that made the rest of it decorative: it is the only route that moves a
 * message OUT of the `new` folder, and while it required the unscoped `voicemail.write` a `user`
 * could list their messages and delete them but got a 403 on "mark as read" — so, the MWI lamp
 * being the NEW count, their desk phone stayed lit until they deleted the message.
 *
 * `voicemail.listen` rather than `voicemail.read` for playback is the one worth stating: the
 * registry separates them for the same reason the CDR area separates `recordings.read` from
 * `recordings.download` — a supervisor may need to know a customer left a message at 4pm without
 * being entitled to hear what they said. A deployment that does not care simply grants both.
 */
@Controller("api/v1/voicemail-boxes")
export class VoicemailMessagesController {
	constructor(
		@Inject(VoicemailMessagesService) private readonly messages: VoicemailMessagesService,
	) {}

	/**
	 * The anonymous media route, declared BEFORE anything with a `:id` segment so the literal wins.
	 *
	 * `@PublicRoute()` is the explicit, auditable opt-out from the global session guard, and it is
	 * correct here for the reason the whole scheme exists: the fetcher of an `<audio src>` has no
	 * session. What replaces it is the token, verified before the service touches the database and
	 * long before it touches the filesystem.
	 *
	 * ## `Range` is honoured
	 *
	 * This route used to answer `accept-ranges: none`, and the comment that said so was honest about
	 * the consequence: a seeking player would ask for a range it never got. The cost of that honesty
	 * was that the scrub bar did not work. `src/media/http-range.ts` decides what a `Range` header
	 * means for an object of a known size; `applyMediaResponse` renders the decision as `200`, `206`
	 * or `416`. The token validation is untouched — it happens first, and a range is only ever
	 * decided for a request that already proved it may read the row.
	 */
	@Get("media")
	@PublicRoute()
	@Header("Cache-Control", "private, no-store")
	async media(
		@Query("token") token: string,
		@Req() request: MediaRequest,
		@Res({ passthrough: true }) reply: MediaReply,
	) {
		return applyMediaResponse(
			reply,
			await this.messages.openSignedMedia(token ?? "", readRangeHeader(request)),
		);
	}

	@Get(":id/messages")
	@RequirePermissions("voicemail.read.own")
	async list(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Query() query: unknown,
	) {
		return await this.messages.list(
			session,
			id,
			parseDto(voicemailMessageListQuerySchema, query ?? {}),
		);
	}

	@Patch(":id/messages/:messageId")
	@RequirePermissions("voicemail.write.own")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("messageId", ParseUUIDPipe) messageId: string,
		@Body() body: unknown,
	) {
		return await this.messages.update(
			session,
			id,
			messageId,
			parseDto(updateVoicemailMessageDto, body),
		);
	}

	@Delete(":id/messages/:messageId")
	@RequirePermissions("voicemail.delete.own")
	async remove(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("messageId", ParseUUIDPipe) messageId: string,
		@Query() query: unknown,
	) {
		const { purge } = parseDto(deleteVoicemailMessageQuerySchema, query ?? {});
		return await this.messages.remove(session, id, messageId, purge);
	}

	/**
	 * Forwards or copies a message into another mailbox in the same organization.
	 *
	 * `voicemail.write.own` because the SOURCE mailbox is the one the caller has to be entitled to:
	 * a forward removes a message from it, and a copy reads one out of it. The TARGET is proved by
	 * tenancy alone inside the service — a user who could only forward into boxes they own could
	 * only forward to themselves, which is the opposite of what the feature is for.
	 */
	@Post(":id/messages/:messageId/forward")
	@RequirePermissions("voicemail.write.own")
	async forward(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("messageId", ParseUUIDPipe) messageId: string,
		@Body() body: unknown,
	) {
		return await this.messages.forward(
			session,
			id,
			messageId,
			parseDto(forwardVoicemailMessageDto, body),
		);
	}

	/**
	 * Mints a playback link.
	 *
	 * `POST` for a read-shaped operation because it creates a credential with a lifetime — see
	 * `voicemail-messages.service.ts`, and `recordings.controller.ts` before it.
	 */
	@Post(":id/messages/:messageId/play-url")
	@RequirePermissions("voicemail.listen.own")
	async playUrl(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("messageId", ParseUUIDPipe) messageId: string,
	) {
		return await this.messages.mintPlaybackLink(session, id, messageId);
	}
}
