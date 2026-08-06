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
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import { createConferenceDto, updateConferenceDto } from "./conferences.dto";
import { ConferencesService } from "./conferences.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/conferences`.
 *
 * `conferences.moderate` is not used here: it governs a LIVE room — mute, kick, lock, record — and
 * that surface belongs to the engine, not to the configuration CRUD. Guarding a room's settings
 * with it would let anyone who can mute a participant re-point the room's recording policy.
 */
@Controller("api/v1/conferences")
export class ConferencesController {
	constructor(@Inject(ConferencesService) private readonly conferences: ConferencesService) {}

	@Get()
	@RequirePermissions("conferences.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.conferences.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("conferences.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conferences.get(session, id);
	}

	@Post()
	@RequirePermissions("conferences.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.conferences.create(session, parseDto(createConferenceDto, body));
	}

	@Patch(":id")
	@RequirePermissions("conferences.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.conferences.update(session, id, parseDto(updateConferenceDto, body));
	}

	@Delete(":id")
	@RequirePermissions("conferences.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conferences.remove(session, id);
	}
}
