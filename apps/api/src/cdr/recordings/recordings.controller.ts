import {
	Controller,
	Get,
	Header,
	Inject,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Res,
} from "@nestjs/common";
import { PublicRoute } from "../../auth/public-route.decorator";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import { recordingListQuerySchema } from "../query/cdr.dto";
import { RecordingsService } from "./recordings.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The one method of the Fastify reply this controller uses.
 *
 * Declared structurally rather than imported as `FastifyReply` because `fastify` is a transitive
 * dependency here (it arrives under `@nestjs/platform-fastify`), and adding it as a direct one to
 * name a type in a single signature would be a dependency taken on for a type import. The same
 * reasoning `auth-bootstrap.ts` applies to `AuthHttpServer`.
 */
interface MediaReply {
	header(name: string, value: string): unknown;
}

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
	 */
	@Get("media")
	@PublicRoute()
	@Header("Cache-Control", "private, no-store")
	async media(@Query("token") token: string, @Res({ passthrough: true }) reply: MediaReply) {
		const media = await this.recordings.openSignedMedia(token ?? "");
		void reply.header("content-type", media.contentType);
		void reply.header("content-length", String(media.sizeBytes));
		void reply.header("content-disposition", `inline; filename="${media.fileName}"`);
		// `accept-ranges: none` is honest rather than restrictive: this streams the whole object, so
		// claiming range support would make a seeking audio player ask for a range it never gets.
		void reply.header("accept-ranges", "none");
		return media.stream;
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
