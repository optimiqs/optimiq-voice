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
import {
	createFaxServerDto,
	faxMessageListQuerySchema,
	faxServerListQuerySchema,
	sendFaxDto,
	updateFaxServerDto,
} from "./fax.dto";
import { FaxService } from "./fax.service";
import type { MediaReply, MediaRequest } from "../../media/media-http";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/faxes` — fax servers, their inbox/outbox, and the send action.
 *
 * ## Route order
 *
 * `media` and `messages` are literal segments and `:id` is parametric. Fastify's router
 * (`find-my-way`) is a radix tree that prefers a static segment over a parametric one at every level,
 * so `GET /api/v1/faxes/messages` cannot be captured by `GET /api/v1/faxes/:id` — the same property
 * `CdrExportsController` relies on. The literals are still declared first, because relying on a
 * router property is fine and relying on it silently is not.
 *
 * ## The permissions
 *
 * Reads and the download-link are `faxes.read`; the server writes are `faxes.write`; the deletes are
 * `faxes.delete`; the send is `faxes.send` — split from `write` because it is the one act that spends
 * carrier money. The anonymous `media` download carries no session permission: the signed token is
 * the credential, verified before the store is touched, exactly like the CDR export media route.
 */
@Controller("api/v1/faxes")
export class FaxController {
	constructor(@Inject(FaxService) private readonly faxes: FaxService) {}

	/** The anonymous document download, declared before `:id`. The token replaces the session. */
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
			await this.faxes.openSignedFax(token ?? "", readRangeHeader(request)),
		);
	}

	// ---- fax servers -----------------------------------------------------------------------

	@Get()
	@RequirePermissions("faxes.read")
	async listServers(@Session() session: AppSession, @Query() query: unknown) {
		return await this.faxes.listServers(session, parseDto(faxServerListQuerySchema, query ?? {}));
	}

	@Post()
	@RequirePermissions("faxes.write")
	async createServer(@Session() session: AppSession, @Body() body: unknown) {
		return await this.faxes.createServer(session, parseDto(createFaxServerDto, body ?? {}));
	}

	// ---- fax messages (inbox / outbox) -----------------------------------------------------

	@Get("messages")
	@RequirePermissions("faxes.read")
	async listMessages(@Session() session: AppSession, @Query() query: unknown) {
		const parsed = parseDto(faxMessageListQuerySchema, query ?? {});
		return await this.faxes.listMessages(session, parsed.serverId, parsed);
	}

	@Get("messages/:id")
	@RequirePermissions("faxes.read")
	async getMessage(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.faxes.getMessage(session, id);
	}

	/**
	 * Mints a signed download link for a stored fax document.
	 *
	 * `POST` for a read-shaped operation, for the reason the recording and export equivalents record:
	 * it CREATES a credential with a lifetime, and a `GET` that minted one would be cached and logged
	 * as though idempotent.
	 */
	@Post("messages/:id/download-url")
	@RequirePermissions("faxes.read")
	async downloadUrl(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.faxes.mintDownloadLink(session, id);
	}

	@Delete("messages/:id")
	@RequirePermissions("faxes.delete")
	async removeMessage(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.faxes.removeMessage(session, id);
	}

	// ---- fax server by id ------------------------------------------------------------------

	@Get(":id")
	@RequirePermissions("faxes.read")
	async getServer(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.faxes.getServer(session, id);
	}

	@Patch(":id")
	@RequirePermissions("faxes.write")
	async updateServer(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.faxes.updateServer(session, id, parseDto(updateFaxServerDto, body ?? {}));
	}

	@Delete(":id")
	@RequirePermissions("faxes.delete")
	async removeServer(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.faxes.removeServer(session, id);
	}

	/**
	 * Queues an outbound fax.
	 *
	 * `202`, not `201`: what exists after this call is a REQUEST to send, and the send may still fail
	 * at the carrier. `202 Accepted` is the status whose meaning is "understood, not done", so a
	 * client polls the message rather than treating it as delivered.
	 */
	@Post(":id/send")
	@HttpCode(HttpStatus.ACCEPTED)
	@RequirePermissions("faxes.send")
	async send(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.faxes.send(session, id, parseDto(sendFaxDto, body ?? {}));
	}
}
