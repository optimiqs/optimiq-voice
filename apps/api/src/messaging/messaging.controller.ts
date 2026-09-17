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
import { PublicRoute } from "../auth/public-route.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { Session } from "../auth/session.decorator";
import { applyMediaResponse, readRangeHeader } from "../media/media-http";
import { parseDto } from "../pbx/shared/dto";
import {
	conversationListQuerySchema,
	createOptOutDto,
	enableMessagingNumberDto,
	messageListQuerySchema,
	messagingNumberListQuerySchema,
	optOutListQuerySchema,
	sendMessageDto,
	updateConversationDto,
	updateMessagingNumberDto,
} from "./messaging.dto";
import { MessagingMediaRejectedException } from "./messaging.errors";
import { MessagingService } from "./messaging.service";
import type { MediaReply, MediaRequest } from "../media/media-http";
import type { AppSession } from "@optimiq-voice/auth";
import type { FastifyRequest } from "fastify";

/**
 * `/api/v1/messaging` — numbers, conversations, the send action, attachments and the opt-out list.
 *
 * The registration half of this prefix (`brands`, `campaigns`, `toll-free-verifications`) lives in
 * `messaging-registration.controller.ts`. Two controllers on one prefix, split by who touches them:
 * an agent lives in this file's routes all day and an administrator visits the other one twice a
 * year, and the permission each requires follows that split exactly.
 *
 * # Route order
 *
 * Every route here begins with a literal segment, so there is no `:id`-versus-literal ambiguity to
 * resolve. Fastify's router (`find-my-way`) prefers a static segment over a parametric one at every
 * level anyway — the property `FaxController` and `CdrExportsController` both rely on — but this
 * controller does not need to rely on it, which is better.
 *
 * # The permissions
 *
 * Reads are `messaging.read`; the send is `messaging.send`; everything that changes registration,
 * enablement or the suppression list is `messaging.manage`. Marking a thread read and renaming one
 * are `messaging.read` and not `messaging.manage`, deliberately: they are the acts of a person
 * working the inbox, and putting them behind the administrator's grant would mean an agent's own
 * unread badge is something they cannot clear.
 *
 * The anonymous `media` download carries no session permission at all: the signed token is the
 * credential, verified before the store is touched, exactly like the recordings and fax media
 * routes.
 */
@Controller("api/v1/messaging")
export class MessagingController {
	constructor(@Inject(MessagingService) private readonly messaging: MessagingService) {}

	// ---- MMS media -----------------------------------------------------------------------------

	/** The anonymous attachment download. The token replaces the session. */
	@Get("media")
	@PublicRoute()
	@Header("Cache-Control", "private, no-store")
	async media(
		@Query("token") token: unknown,
		@Query("part") part: unknown,
		@Req() request: MediaRequest,
		@Res({ passthrough: true }) reply: MediaReply,
	) {
		// Fastify parses a repeated `?token=` into an ARRAY, and this is a public route: handing that
		// to the verifier would turn a forged link into an unhandled 500 rather than the 403 this area
		// defines for it. Anything that is not a string is simply not a token — the same guard
		// `FaxController.media` carries, for the same bug.
		const rawToken = typeof token === "string" ? token : "";
		const index = typeof part === "string" ? Number.parseInt(part, 10) : 0;
		return applyMediaResponse(
			reply,
			await this.messaging.openSignedMedia(
				rawToken,
				Number.isFinite(index) ? index : -1,
				readRangeHeader(request),
			),
		);
	}

	/**
	 * Uploads one attachment and returns its object key, for a later send to reference.
	 *
	 * Two steps rather than a multipart send, because they fail differently and at different times: an
	 * attachment that is too large or of a refused type should be rejected while the user is still
	 * looking at the file picker, not folded into a send that also has a recipient and a compliance
	 * gate to get wrong. It also means a retried send does not re-upload the bytes.
	 */
	@Post("media")
	@RequirePermissions("messaging.send")
	async upload(@Session() session: AppSession, @Req() request: FastifyRequest) {
		const file = await readMultipartFile(request);
		return await this.messaging.storeUpload(session, file);
	}

	// ---- messaging numbers ---------------------------------------------------------------------

	@Get("numbers")
	@RequirePermissions("messaging.read")
	async listNumbers(@Session() session: AppSession, @Query() query: unknown) {
		return await this.messaging.listNumbers(
			session,
			parseDto(messagingNumberListQuerySchema, query ?? {}),
		);
	}

	@Get("numbers/:id")
	@RequirePermissions("messaging.read")
	async getNumber(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.messaging.getNumber(session, id);
	}

	@Post("numbers")
	@RequirePermissions("messaging.manage")
	async enableNumber(@Session() session: AppSession, @Body() body: unknown) {
		return await this.messaging.enableNumber(
			session,
			parseDto(enableMessagingNumberDto, body ?? {}),
		);
	}

	@Patch("numbers/:id")
	@RequirePermissions("messaging.manage")
	async updateNumber(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.messaging.updateNumber(
			session,
			id,
			parseDto(updateMessagingNumberDto, body ?? {}),
		);
	}

	/**
	 * Turns messaging off for a number.
	 *
	 * Answers `{ deleted: false }` rather than a 409 when the line has conversation history: the row
	 * is disabled and kept, because a tenant must not be able to erase what was said to consumers by
	 * unticking a box. The response says which of the two happened so the UI can too.
	 */
	@Delete("numbers/:id")
	@RequirePermissions("messaging.manage")
	async removeNumber(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.messaging.removeNumber(session, id);
	}

	// ---- conversations -------------------------------------------------------------------------

	@Get("conversations")
	@RequirePermissions("messaging.read")
	async listConversations(@Session() session: AppSession, @Query() query: unknown) {
		return await this.messaging.listConversations(
			session,
			parseDto(conversationListQuerySchema, query ?? {}),
		);
	}

	@Get("conversations/:id")
	@RequirePermissions("messaging.read")
	async getConversation(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.messaging.getConversation(session, id);
	}

	@Patch("conversations/:id")
	@RequirePermissions("messaging.read")
	async updateConversation(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.messaging.updateConversation(
			session,
			id,
			parseDto(updateConversationDto, body ?? {}),
		);
	}

	@Get("conversations/:id/messages")
	@RequirePermissions("messaging.read")
	async listMessages(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Query() query: unknown,
	) {
		return await this.messaging.listMessages(
			session,
			id,
			parseDto(messageListQuerySchema, query ?? {}),
		);
	}

	@Post("conversations/:id/read")
	@RequirePermissions("messaging.read")
	async markRead(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.messaging.markRead(session, id);
	}

	// ---- messages ------------------------------------------------------------------------------

	@Get("messages/:id")
	@RequirePermissions("messaging.read")
	async getMessage(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.messaging.getMessage(session, id);
	}

	/**
	 * Mints a signed link to one part of a message's media.
	 *
	 * `POST` for a read-shaped operation, for the reason the recording and fax equivalents record: it
	 * CREATES a credential with a lifetime, and a `GET` that minted one would be cached and logged as
	 * though it were idempotent.
	 */
	@Post("messages/:id/media-url")
	@RequirePermissions("messaging.read")
	async mediaUrl(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Query("part") part: unknown,
		@Body() body: unknown,
	) {
		// Either identifier: `?part=<index>`, or `{ objectKey }` in the body, which is what a client
		// naturally has because the key came back on the message row. Both are resolved against that
		// row, so neither can name an object the message does not own.
		const objectKey = (body as { objectKey?: unknown } | null)?.objectKey;
		if (typeof objectKey === "string" && objectKey.length > 0) {
			return await this.messaging.mintMediaLink(session, id, objectKey);
		}
		const index = typeof part === "string" ? Number.parseInt(part, 10) : 0;
		return await this.messaging.mintMediaLink(session, id, Number.isFinite(index) ? index : -1);
	}

	/**
	 * Queues one outbound message.
	 *
	 * `202`, not `201`: what exists after this call is a REQUEST to send, and the send may still be
	 * refused by the carrier. `202 Accepted` means "understood, not done", so a client watches the
	 * message's status rather than treating the response as delivery.
	 *
	 * The three compliance refusals — unregistered number, opted-out recipient, quiet hours — are
	 * 422s with distinct `code`s and a human sentence. See `messaging.errors.ts` for why they are
	 * three errors and not one.
	 */
	@Post("messages")
	@HttpCode(HttpStatus.ACCEPTED)
	@RequirePermissions("messaging.send")
	async send(@Session() session: AppSession, @Body() body: unknown) {
		return await this.messaging.send(session, parseDto(sendMessageDto, body ?? {}));
	}

	// ---- opt-outs ------------------------------------------------------------------------------

	@Get("opt-outs")
	@RequirePermissions("messaging.read")
	async listOptOuts(@Session() session: AppSession, @Query() query: unknown) {
		return await this.messaging.listOptOuts(session, parseDto(optOutListQuerySchema, query ?? {}));
	}

	@Post("opt-outs")
	@RequirePermissions("messaging.manage")
	async createOptOut(@Session() session: AppSession, @Body() body: unknown) {
		return await this.messaging.createOptOut(session, parseDto(createOptOutDto, body ?? {}));
	}

	/**
	 * Removes a suppression.
	 *
	 * `messaging.manage` and not `messaging.send`, which is the sharper of the two boundaries in this
	 * area: this asserts that somebody who said stop has said start, and it should be answerable by a
	 * named person. The service logs the actor at `warn` for the same reason.
	 */
	@Delete("opt-outs/:id")
	@RequirePermissions("messaging.manage")
	async removeOptOut(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.messaging.removeOptOut(session, id);
	}
}

/**
 * Reads one file out of a multipart request.
 *
 * Written here rather than reached for from a shared helper because this API's other upload paths
 * (prompts, greetings, the branding logo) each parse multipart their own way against
 * `@fastify/multipart`, and unifying them is a refactor that belongs to whoever owns those files.
 * What this does add is the two guards an upload route must not be missing: exactly one file, and
 * the bytes read through the body limit the plugin was registered with rather than into an unbounded
 * buffer.
 */
async function readMultipartFile(
	request: FastifyRequest,
): Promise<{ readonly bytes: Buffer; readonly contentType: string | undefined }> {
	const multipart = request as FastifyRequest & {
		isMultipart?: () => boolean;
		file?: () => Promise<
			| {
					readonly mimetype?: string;
					toBuffer: () => Promise<Buffer>;
			  }
			| undefined
		>;
	};
	if (typeof multipart.isMultipart !== "function" || !multipart.isMultipart()) {
		throw new MessagingMediaRejectedException("Send the attachment as a multipart upload.");
	}
	if (typeof multipart.file !== "function") {
		throw new MessagingMediaRejectedException(
			"Multipart uploads are not available on this server.",
		);
	}
	const part = await multipart.file();
	if (part === undefined) {
		throw new MessagingMediaRejectedException("No file was attached.");
	}
	return { bytes: await part.toBuffer(), contentType: part.mimetype };
}
