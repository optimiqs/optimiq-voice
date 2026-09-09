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
import { promptListQuerySchema, updatePromptDto } from "./prompts.dto";
import { PromptsService } from "./prompts.service";
import type { MediaReply, MediaRequest } from "../../media/media-http";
import type { MultipartRequest } from "../media/media-upload";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/prompts` — the tenant's audio library.
 *
 * ## The permissions, and the compromise they represent
 *
 * | Route                       | Permission              |
 * | --------------------------- | ----------------------- |
 * | `GET /prompts`, `GET /:id`  | `recordings.read`       |
 * | `POST`, `PATCH`             | `recordings.configure`  |
 * | `DELETE`                    | `recordings.delete`     |
 * | `POST /:id/play-url`        | `recordings.read`       |
 *
 * There is no `media.*` pair in `@optimiq-voice/auth`, and the registry is at its documented
 * ceiling — the same constraint `devices.controller.ts` and `voicemail-boxes.controller.ts` each
 * record when they reuse an adjacent permission rather than mint one. So this reuses
 * `recordings.*`, which is what the sibling `phrases.controller.ts` already guards the same table
 * with.
 *
 * It used to be `settings.*`, and that was a hole rather than a compromise: `settings.read` is in
 * `SELF_SERVICE_PERMISSIONS`, so the `user` and `agent` roles held it. `PROMPT_KINDS` includes
 * `phrase` and `moh` and `promptListQuerySchema.kind` accepts the whole enum, so any signed-in user
 * of a tenant could enumerate every IVR prompt, greeting and hold-music file in the organization —
 * including the phrase rows `phrases.controller.ts` gates behind `recordings.read` — and mint an
 * unauthenticated playback URL for each. `recordings.*` is manager-level and closes that.
 *
 * The compromise that remains is real and worth naming: an operator who may build an IVR
 * (`ivr.write`) cannot upload the greeting it plays unless they also hold `recordings.configure`.
 * The fix is a `media.read` / `media.write` pair in the registry, and it is recorded as a follow-up
 * rather than papered over by guarding uploads with `ivr.write`, which would let anyone who can
 * edit one menu replace audio every other feature plays.
 *
 * ## `POST /:id/play-url` is a read guarded by a read permission, and a POST anyway
 *
 * `POST` for a read-shaped operation because it CREATES a credential with a lifetime — the argument
 * `recordings.controller.ts` and `voicemail-messages.controller.ts` both make. A `GET` that minted
 * one would be prefetched, cached and logged as though it were idempotent, which it is not in the
 * way that matters.
 */
@Controller("api/v1/prompts")
export class PromptsController {
	constructor(@Inject(PromptsService) private readonly prompts: PromptsService) {}

	/**
	 * The anonymous media route, declared BEFORE anything with a `:id` segment so the literal wins.
	 *
	 * `@PublicRoute()` is the explicit, auditable opt-out from the global session guard, and it is
	 * correct here for the reason the whole scheme exists: the fetcher of an `<audio src>` has no
	 * session. What replaces it is the token, verified before the service touches the database and
	 * long before it touches the filesystem.
	 *
	 * The `Range` header is read off the request and handed to the service, which decides against
	 * the object's real size. `206`, `200` and `416` are all produced here rather than in the
	 * service, because only the controller can set a status code.
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
			await this.prompts.openSignedMedia(token ?? "", readRangeHeader(request)),
		);
	}

	@Get()
	@RequirePermissions("recordings.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.prompts.list(session, parseDto(promptListQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("recordings.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.prompts.get(session, id);
	}

	/**
	 * Uploads one audio file into the library.
	 *
	 * `multipart/form-data`, with the audio in a part named `file` and the metadata (`name`,
	 * `language`) as sibling text parts. There is no JSON create endpoint and there will not be one:
	 * `prompt.object_key` is `notNull`, so a row without audio is not expressible — see
	 * `prompts.dto.ts`.
	 *
	 * The raw request rather than a `@Body()`: the multipart stream has to be consumed as a stream
	 * so the size cap can stop it, and Nest's body pipeline would have to buffer it whole first.
	 */
	@Post()
	@HttpCode(HttpStatus.CREATED)
	@RequirePermissions("recordings.configure")
	async upload(@Session() session: AppSession, @Req() request: MultipartRequest) {
		return await this.prompts.upload(session, request, { kind: "prompt" });
	}

	@Patch(":id")
	@RequirePermissions("recordings.configure")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.prompts.update(session, id, parseDto(updatePromptDto, body));
	}

	@Delete(":id")
	@RequirePermissions("recordings.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.prompts.remove(session, id);
	}

	@Post(":id/play-url")
	@RequirePermissions("recordings.read")
	async playUrl(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.prompts.mintPlaybackLink(session, id);
	}
}
