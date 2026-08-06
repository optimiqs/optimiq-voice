import {
	Controller,
	Get,
	Header,
	Inject,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	Res,
} from "@nestjs/common";
import { PublicRoute } from "../../auth/public-route.decorator";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { applyMediaResponse, readRangeHeader } from "../../media/media-http";
import { parseDto } from "../../pbx/shared/dto";
import { recordingListQuerySchema } from "../query/cdr.dto";
import { RecordingsService } from "./recordings.service";
import type { MediaReply, MediaRequest } from "../../media/media-http";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/recordings` — media metadata, and the signed route that reaches the bytes.
 *
 * Distinct from `src/http/recordings.controller.ts`, which serves the legacy
 * `/api/recordings/:id` for `apps/autopilot`'s webhook payloads. That route stays for now because
 * removing it breaks every conversation-ended webhook already in the wild; the migration is to
 * have autopilot mint one of these instead, and it is a change on autopilot's side. The two do not
 * overlap: different prefix, different mechanism, and this one is not enumerable.
 */
@Controller("api/v1/recordings")
export class CdrRecordingsController {
	constructor(@Inject(RecordingsService) private readonly recordings: RecordingsService) {}

	@Get()
	@RequirePermissions("recordings.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.recordings.list(session, parseDto(recordingListQuerySchema, query ?? {}));
	}

	/**
	 * The anonymous media route, declared BEFORE `:id` so the literal segment wins.
	 *
	 * `@PublicRoute()` is the explicit, auditable opt-out from the global guard, and it is correct
	 * here for the reason the whole scheme exists: the fetcher of an `<audio src>` or a webhook
	 * payload has no session. What replaces the session is the token, which the service verifies
	 * before it touches the database and long before it touches the filesystem.
	 *
	 * The token arrives as a QUERY parameter — see `recordingMediaPath` for why the path form was
	 * tried first and abandoned (Fastify caps a route parameter at 100 characters).
	 *
	 * ## `Range` is honoured, and the scrub bar depends on it
	 *
	 * This route used to answer `accept-ranges: none`, which was honest about what it did and is
	 * exactly why dragging the playhead on a forty-minute recording either did nothing or restarted
	 * it. A browser decides whether a media element is seekable from `accept-ranges` on the FIRST
	 * response and from whether a subsequent `Range` request comes back `206`, so both halves had
	 * to change together. `src/media/http-range.ts` decides; `applyMediaResponse` renders the
	 * decision — including the `416` with a `content-range: bytes * /<size>`, which is the only
	 * answer that lets a player recover from a seek past the end.
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
			await this.recordings.openSignedMedia(token ?? "", readRangeHeader(request)),
		);
	}

	@Get(":id")
	@RequirePermissions("recordings.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.recordings.get(session, id);
	}

	/**
	 * Mints a download link.
	 *
	 * `POST` for a read-shaped operation, deliberately: it CREATES a credential with a lifetime,
	 * and a `GET` that mints one would be cached, prefetched and logged as though it were idempotent
	 * — which it is not, in the way that matters.
	 *
	 * `recordings.download` and not `recordings.read`: seeing that a call was recorded and being
	 * allowed to listen to it are different decisions, and the registry already separates them.
	 */
	@Post(":id/download-url")
	@RequirePermissions("recordings.download")
	async downloadUrl(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.recordings.mintDownloadLink(session, id);
	}
}
