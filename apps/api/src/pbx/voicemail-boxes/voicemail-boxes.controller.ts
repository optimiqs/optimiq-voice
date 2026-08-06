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
import { createVoicemailBoxDto, updateVoicemailBoxDto } from "./voicemail-boxes.dto";
import { VoicemailBoxesService } from "./voicemail-boxes.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/voicemail-boxes` — mailbox configuration, not its messages. */
@Controller("api/v1/voicemail-boxes")
export class VoicemailBoxesController {
	constructor(@Inject(VoicemailBoxesService) private readonly boxes: VoicemailBoxesService) {}

	@Get()
	@RequirePermissions("voicemail.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.boxes.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("voicemail.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.boxes.get(session, id);
	}

	@Post()
	@RequirePermissions("voicemail.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.boxes.create(session, parseDto(createVoicemailBoxDto, body));
	}

	@Patch(":id")
	@RequirePermissions("voicemail.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.boxes.update(session, id, parseDto(updateVoicemailBoxDto, body));
	}

	@Delete(":id")
	@RequirePermissions("voicemail.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.boxes.remove(session, id);
	}
}
