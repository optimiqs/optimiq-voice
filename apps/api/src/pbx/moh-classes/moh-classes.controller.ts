import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
	Req,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { PromptsService } from "../prompts/prompts.service";
import { parseDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import { createMohClassDto, updateMohClassDto } from "./moh-classes.dto";
import { MohClassesService } from "./moh-classes.service";
import type { MultipartRequest } from "../media/media-upload";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/moh-classes` — hold-music classes, and the audio under them.
 *
 * ## Two resources, one prefix, and why the files are not a `PbxChildResource`
 *
 * A class's files look like a child collection and are deliberately not modelled as one. A
 * `PbxChildResource` exists to give a collection the repository's generic create/update/delete plus
 * `PUT …/reorder`, all over JSON bodies. MOH files have none of those needs and one the machinery
 * cannot express: they are CREATED BY AN UPLOAD, and the child machinery has no seam for a
 * multipart request. They also live in `prompt`, a table with its own resource, its own reference
 * guard and its own media route — so routing them through a second descriptor would give one table
 * two owners.
 *
 * So the files are served by `PromptsService` under this prefix, and the URL is the authority on
 * which class a file joins: the `:id` in the path wins over any `mohClassId` a form part carries.
 *
 * ## Permissions
 *
 * `settings.read` / `settings.write`, for the reason `prompts.controller.ts` sets out at length:
 * there is no `media.*` pair, the registry is at its documented ceiling, and the library is
 * organization-wide configuration every call feature draws on.
 */
@Controller("api/v1/moh-classes")
export class MohClassesController {
	constructor(
		@Inject(MohClassesService) private readonly classes: MohClassesService,
		@Inject(PromptsService) private readonly prompts: PromptsService,
	) {}

	@Get()
	@RequirePermissions("settings.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.classes.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("settings.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.classes.get(session, id);
	}

	@Post()
	@RequirePermissions("settings.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.classes.create(session, parseDto(createMohClassDto, body));
	}

	/**
	 * Edits a class.
	 *
	 * `moh_class` IS a routing table, so this recompiles the tenant and republishes the artifact —
	 * which is what makes a RENAME reach the engine at all. Five node kinds carry the resolved class
	 * NAME (`packages/routing` §2.5), so a class renamed without a recompile would leave every
	 * extension, ring group, queue, conference and park lot that names it asking the media server
	 * for a class that no longer exists.
	 */
	@Patch(":id")
	@RequirePermissions("settings.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.classes.update(session, id, parseDto(updateMohClassDto, body));
	}

	@Delete(":id")
	@RequirePermissions("settings.write")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.classes.remove(session, id);
	}

	// -------------------------------------------------------------------------------------------
	// The audio under a class
	// -------------------------------------------------------------------------------------------

	/**
	 * The class's files, in the order a `library` class plays them when `shuffle` is off.
	 *
	 * Not paginated, on the same terms as every other child collection in this area: a hold-music
	 * class with more than a screenful of files is a design problem, not a paging problem.
	 */
	@Get(":id/files")
	@RequirePermissions("settings.read")
	async listFiles(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.prompts.listForMohClass(session, id);
	}

	/** Uploads one audio file into the class. See `prompts.controller.ts` for the multipart shape. */
	@Post(":id/files")
	@HttpCode(HttpStatus.CREATED)
	@RequirePermissions("settings.write")
	async uploadFile(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Req() request: MultipartRequest,
	) {
		return await this.prompts.upload(session, request, { kind: "moh", mohClassId: id });
	}

	/**
	 * Removes one file from the class, object included.
	 *
	 * A `DELETE` on `/prompts/:id` would do the same thing, and this route exists anyway because a
	 * caller that reached the file through its class should be able to remove it through its class —
	 * and because the pairing is checked: a file id that belongs to a DIFFERENT class answers 404
	 * rather than deleting somebody else's hold music, exactly as
	 * `voicemail-messages.service.ts` proves a message belongs to the box in its URL.
	 */
	@Delete(":id/files/:fileId")
	@RequirePermissions("settings.write")
	async removeFile(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("fileId", ParseUUIDPipe) fileId: string,
	) {
		return await this.prompts.removeMohFile(session, id, fileId);
	}
}
