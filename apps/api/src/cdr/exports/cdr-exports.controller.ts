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
import { cdrExportListQuerySchema, createCdrExportDto } from "./cdr-exports.dto";
import { CdrExportsService } from "./cdr-exports.service";
import type { MediaReply, MediaRequest } from "../../media/media-http";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/cdr/exports` — asking the ledger a question too big to answer in a request.
 *
 * ## Every route is `cdr.export`, including the reads
 *
 * `cdr.export` has been in the registry since it was written and has enforced nothing; this is
 * where it starts meaning something. The reads could have been `cdr.read` on the argument that a
 * job row is metadata rather than call data, and they are not, for two reasons.
 *
 * The first is that a job row is not metadata about the platform, it is a record of a QUESTION
 * somebody asked: `filters` holds the extension, the DID and the free-text term they searched for.
 * "Who has been pulling reports on this number" is a different disclosure from "who called it",
 * and the narrower grant is the right one.
 *
 * The second is the download. `POST :id/download-url` mints a credential that reaches a CSV of the
 * organization's call history, so it cannot be gated more loosely than the grant that created the
 * file — and once the download is `cdr.export`, splitting the list and the get onto `cdr.read`
 * would only produce a role that can see exports exist and cannot open them. That is a shape with
 * a use (an auditor) and no requester, so it is not built.
 *
 * There is no `cdr.export.delete`. Deleting an export destroys a derived artefact the requester
 * asked for, not a record — the JOB row survives a delete of the file when it expires, and a
 * caller who may create exports may tidy up their own. The same argument `webhooks.delete` lost,
 * decided the same way.
 *
 * ## Route order
 *
 * `media` and `exports` are literal segments and `:id` is parametric. Fastify's router
 * (`find-my-way`) is a radix tree that prefers a static segment over a parametric one at every
 * level regardless of declaration order, so `GET /api/v1/cdr/exports/media` cannot be captured by
 * `GET /api/v1/cdr/exports/:id` — the same property `VoicemailMessagesController` relies on. The
 * declaration order below still puts the literal first, because relying on a router property is
 * fine and relying on it silently is not.
 *
 * Note that this controller's prefix sits UNDER `CdrController`'s (`api/v1/cdr`), whose `@Get(":id")`
 * would otherwise match `exports`. The same radix rule applies across controllers, because Fastify
 * has one router for the whole process.
 */
@Controller("api/v1/cdr/exports")
export class CdrExportsController {
	constructor(@Inject(CdrExportsService) private readonly exports: CdrExportsService) {}

	/**
	 * The anonymous download, declared before `:id`.
	 *
	 * `@PublicRoute()` is the explicit opt-out from the global guard, correct here for the reason
	 * the whole signed-link scheme exists: the fetcher of a browser download or a scheduled
	 * integration has no session. What replaces the session is the token, verified before the
	 * service touches the database and long before it touches the object store.
	 *
	 * `no-store` because the response body is a copy of the organization's call history and a
	 * shared cache holding one is a data leak with a TTL.
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
			await this.exports.openSignedExport(token ?? "", readRangeHeader(request)),
		);
	}

	@Get()
	@RequirePermissions("cdr.export")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.exports.list(session, parseDto(cdrExportListQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("cdr.export")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.exports.get(session, id);
	}

	/**
	 * Queues one.
	 *
	 * `202` and not `201`, deliberately. `201 Created` says the thing you asked for now exists; what
	 * exists after this call is a REQUEST for it, and the file may never exist at all — the job can
	 * fail on the row cap. `202 Accepted` is the status whose whole meaning is "understood, not
	 * done", and a client that switches on it will poll rather than fetch.
	 */
	@Post()
	@HttpCode(HttpStatus.ACCEPTED)
	@RequirePermissions("cdr.export")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.exports.create(session, parseDto(createCdrExportDto, body ?? {}));
	}

	/**
	 * Mints a download link.
	 *
	 * `POST` for a read-shaped operation, for the reason the recording equivalent records: it
	 * CREATES a credential with a lifetime, and a `GET` that minted one would be cached, prefetched
	 * and logged as though it were idempotent.
	 */
	@Post(":id/download-url")
	@RequirePermissions("cdr.export")
	async downloadUrl(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.exports.mintDownloadLink(session, id);
	}

	@Delete(":id")
	@RequirePermissions("cdr.export")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.exports.remove(session, id);
	}
}
