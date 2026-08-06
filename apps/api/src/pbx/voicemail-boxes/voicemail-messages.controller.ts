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
	Res,
} from "@nestjs/common";
import { PublicRoute } from "../../auth/public-route.decorator";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import {
	deleteVoicemailMessageQuerySchema,
	updateVoicemailMessageDto,
	voicemailMessageListQuerySchema,
} from "./voicemail-messages.dto";
import { VoicemailMessagesService } from "./voicemail-messages.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The one method of the Fastify reply this controller uses.
 *
 * Declared structurally rather than imported as `FastifyReply`, for the reason
 * `recordings.controller.ts` records: `fastify` arrives here transitively under
 * `@nestjs/platform-fastify`, and adding it as a direct dependency to name a type in one signature
 * would be a dependency taken on for a type import.
 */
interface MediaReply {
	header(name: string, value: string): unknown;
}

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
 * | Route                        | Permission          | Reasoning                                  |
 * | ---------------------------- | ------------------- | ------------------------------------------ |
 * | `GET …/messages`             | `voicemail.read`    | Seeing what is in a mailbox                 |
 * | `PATCH …/messages/:id`       | `voicemail.write`   | Changing a mailbox's state                  |
 * | `DELETE …/messages/:id`      | `voicemail.delete`  | The registry already separates it from write |
 * | `POST …/messages/:id/play-url` | `voicemail.listen` | Seeing that a message exists and LISTENING to it are different decisions |
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
	 */
	@Get("media")
	@PublicRoute()
	@Header("Cache-Control", "private, no-store")
	async media(@Query("token") token: string, @Res({ passthrough: true }) reply: MediaReply) {
		const media = await this.messages.openSignedMedia(token ?? "");
		void reply.header("content-type", media.contentType);
		void reply.header("content-length", String(media.sizeBytes));
		void reply.header("content-disposition", `inline; filename="${media.fileName}"`);
		// `accept-ranges: none` is honest rather than restrictive: this streams the whole object, so
		// claiming range support would make a seeking audio player ask for a range it never gets.
		void reply.header("accept-ranges", "none");
		return media.stream;
	}

	@Get(":id/messages")
	@RequirePermissions("voicemail.read")
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
	@RequirePermissions("voicemail.write")
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
	@RequirePermissions("voicemail.delete")
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
	 * Mints a playback link.
	 *
	 * `POST` for a read-shaped operation because it creates a credential with a lifetime — see
	 * `voicemail-messages.service.ts`, and `recordings.controller.ts` before it.
	 */
	@Post(":id/messages/:messageId/play-url")
	@RequirePermissions("voicemail.listen")
	async playUrl(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("messageId", ParseUUIDPipe) messageId: string,
	) {
		return await this.messages.mintPlaybackLink(session, id, messageId);
	}
}
