import {
	Body,
	Controller,
	Delete,
	Get,
	Header,
	HttpCode,
	HttpStatus,
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
import { updateGreetingDto } from "./voicemail-greetings.dto";
import { VoicemailGreetingsService } from "./voicemail-greetings.service";
import type { MediaReply, MediaRequest } from "../../media/media-http";
import type { MultipartRequest } from "../media/media-upload";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/voicemail-boxes/:id/greetings` — what a caller hears before the beep.
 *
 * A third controller on the `voicemail-boxes` prefix, alongside the box's CONFIGURATION
 * (`voicemail-boxes.controller.ts`) and its CONTENTS (`voicemail-messages.controller.ts`). The
 * split is the same one those two already make and it is about lifecycle rather than about URLs:
 * a greeting is a routing input whose every write recompiles the tenant, a message is not a routing
 * input at all, and the box row is edited through the Effect repository. Three lifecycles, three
 * classes.
 *
 * ## The permissions
 *
 * | Route                                   | Permission          |
 * | --------------------------------------- | ------------------- |
 * | `GET …/greetings`                       | `voicemail.read`    |
 * | `POST …/greetings` (upload)             | `voicemail.write`   |
 * | `POST …/:gid/activate` / `/deactivate`  | `voicemail.write`   |
 * | `PATCH …/:gid`                          | `voicemail.write`   |
 * | `DELETE …/:gid`                         | `voicemail.delete`  |
 * | `POST …/:gid/play-url`                  | `voicemail.listen`  |
 *
 * `voicemail.listen` for preview and not `voicemail.read`, on exactly the terms
 * `voicemail-messages.controller.ts` sets out: seeing that a greeting exists and HEARING it are
 * different decisions. A greeting is the mailbox owner's recorded voice.
 *
 * `voicemail.delete` for the delete because it destroys audio, and `voicemail.write` for
 * activation because it does not: deactivating a temporary greeting is a change of state that the
 * same admin can undo in one click.
 */
@Controller("api/v1/voicemail-boxes")
export class VoicemailGreetingsController {
	constructor(
		@Inject(VoicemailGreetingsService) private readonly greetings: VoicemailGreetingsService,
	) {}

	/**
	 * The anonymous greeting-media route.
	 *
	 * Declared with TWO literal segments (`greetings/media`) under a prefix whose sibling routes
	 * take a `:id`, which resolves because Fastify's router prefers a static segment over a
	 * parametric one at every level — the property `pbx.module.ts` already relies on for
	 * `GET /voicemail-boxes/media`. A URL of `/voicemail-boxes/greetings/media` therefore reaches
	 * here rather than `GET /voicemail-boxes/:id/messages` with `id = "greetings"`, which would in
	 * any case fail `ParseUUIDPipe`.
	 */
	@Get("greetings/media")
	@PublicRoute()
	@Header("Cache-Control", "private, no-store")
	async media(
		@Query("token") token: string,
		@Req() request: MediaRequest,
		@Res({ passthrough: true }) reply: MediaReply,
	) {
		return applyMediaResponse(
			reply,
			await this.greetings.openSignedMedia(token ?? "", readRangeHeader(request)),
		);
	}

	@Get(":id/greetings")
	@RequirePermissions("voicemail.read")
	async list(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.greetings.list(session, id);
	}

	/**
	 * Uploads a greeting and, unless told otherwise, activates it.
	 *
	 * The recompile is the point: `voicemail_greeting` is a routing input, and the compiled
	 * artifact carries the ACTIVE greeting's object key as `object://<key>`. An upload that did not
	 * recompile would leave the engine playing the previous recording until something unrelated
	 * recompiled the tenant — the same failure the set-PIN endpoint exists to avoid, with the
	 * mailbox's voice instead of its PIN.
	 */
	@Post(":id/greetings")
	@HttpCode(HttpStatus.CREATED)
	@RequirePermissions("voicemail.write")
	async upload(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Req() request: MultipartRequest,
	) {
		return await this.greetings.upload(session, id, request);
	}

	@Patch(":id/greetings/:greetingId")
	@RequirePermissions("voicemail.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("greetingId", ParseUUIDPipe) greetingId: string,
		@Body() body: unknown,
	) {
		return await this.greetings.update(session, id, greetingId, parseDto(updateGreetingDto, body));
	}

	/** Makes this greeting the active one for its kind. The kind comes off the row, not the body. */
	@Post(":id/greetings/:greetingId/activate")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("voicemail.write")
	async activate(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("greetingId", ParseUUIDPipe) greetingId: string,
	) {
		return await this.greetings.activate(session, id, greetingId);
	}

	/**
	 * Clears it without deleting the recording.
	 *
	 * `DELETE …/activate` would have said the same thing in fewer characters and would have made
	 * "stop using this greeting" and "throw this greeting away" adjacent enough to confuse, on a
	 * screen where one is reversible and the other is not.
	 */
	@Post(":id/greetings/:greetingId/deactivate")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("voicemail.write")
	async deactivate(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("greetingId", ParseUUIDPipe) greetingId: string,
	) {
		return await this.greetings.deactivate(session, id, greetingId);
	}

	@Delete(":id/greetings/:greetingId")
	@RequirePermissions("voicemail.delete")
	async remove(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("greetingId", ParseUUIDPipe) greetingId: string,
	) {
		return await this.greetings.remove(session, id, greetingId);
	}

	@Post(":id/greetings/:greetingId/play-url")
	@RequirePermissions("voicemail.listen")
	async playUrl(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("greetingId", ParseUUIDPipe) greetingId: string,
	) {
		return await this.greetings.mintPlaybackLink(session, id, greetingId);
	}
}
