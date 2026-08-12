import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto, reorderDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import {
	createSharedLineAppearanceDto,
	createSharedLineDto,
	updateSharedLineAppearanceDto,
	updateSharedLineDto,
} from "./shared-lines.dto";
import { SharedLineAppearancesService, SharedLinesService } from "./shared-lines.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/shared-lines` and its nested `/appearances` (one extension's button on the line). */
@Controller("api/v1/shared-lines")
export class SharedLinesController {
	constructor(
		@Inject(SharedLinesService) private readonly lines: SharedLinesService,
		@Inject(SharedLineAppearancesService)
		private readonly appearances: SharedLineAppearancesService,
	) {}

	@Get()
	@RequirePermissions("shared-lines.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.lines.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("shared-lines.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.lines.get(session, id);
	}

	@Post()
	@RequirePermissions("shared-lines.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.lines.create(session, parseDto(createSharedLineDto, body));
	}

	@Patch(":id")
	@RequirePermissions("shared-lines.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.lines.update(session, id, parseDto(updateSharedLineDto, body));
	}

	@Delete(":id")
	@RequirePermissions("shared-lines.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.lines.remove(session, id);
	}

	// --- appearances ---------------------------------------------------------------------------

	@Get(":id/appearances")
	@RequirePermissions("shared-lines.read")
	async listAppearances(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.appearances.list(session, id);
	}

	@Post(":id/appearances")
	@RequirePermissions("shared-lines.write")
	async createAppearance(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.appearances.create(
			session,
			id,
			parseDto(createSharedLineAppearanceDto, body),
		);
	}

	/**
	 * Replaces the appearance order — and therefore the button numbering — in one transaction.
	 *
	 * `PUT` rather than `PATCH` because the body is the complete order, not a delta (see `reorderDto`).
	 * The ordinal here is the appearance index the phone lights and sipd stamps into `Call-Info`, so a
	 * per-row shuffle would publish N intermediate button layouts to the routing cache, and the
	 * `(line, ordinal)` unique index would refuse most of them anyway.
	 */
	@Put(":id/appearances/reorder")
	@RequirePermissions("shared-lines.write")
	async reorderAppearances(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.appearances.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/appearances/:appearanceId")
	@RequirePermissions("shared-lines.write")
	async updateAppearance(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("appearanceId", ParseUUIDPipe) appearanceId: string,
		@Body() body: unknown,
	) {
		return await this.appearances.update(
			session,
			id,
			appearanceId,
			parseDto(updateSharedLineAppearanceDto, body),
		);
	}

	@Delete(":id/appearances/:appearanceId")
	@RequirePermissions("shared-lines.write")
	async removeAppearance(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("appearanceId", ParseUUIDPipe) appearanceId: string,
	) {
		return await this.appearances.remove(session, id, appearanceId);
	}
}
