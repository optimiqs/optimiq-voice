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
import { createTrunkDto, updateTrunkDto } from "./trunks.dto";
import { TrunksService } from "./trunks.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/trunks` — carrier gateways. */
@Controller("api/v1/trunks")
export class TrunksController {
	constructor(@Inject(TrunksService) private readonly trunks: TrunksService) {}

	@Get()
	@RequirePermissions("trunks.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.trunks.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("trunks.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.trunks.get(session, id);
	}

	@Post()
	@RequirePermissions("trunks.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.trunks.create(session, parseDto(createTrunkDto, body));
	}

	@Patch(":id")
	@RequirePermissions("trunks.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.trunks.update(session, id, parseDto(updateTrunkDto, body));
	}

	@Delete(":id")
	@RequirePermissions("trunks.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.trunks.remove(session, id);
	}
}
