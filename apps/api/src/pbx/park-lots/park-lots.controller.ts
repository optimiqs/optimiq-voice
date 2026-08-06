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
import { createParkLotDto, updateParkLotDto } from "./park-lots.dto";
import { ParkLotsService } from "./park-lots.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/park-lots`. */
@Controller("api/v1/park-lots")
export class ParkLotsController {
	constructor(@Inject(ParkLotsService) private readonly lots: ParkLotsService) {}

	@Get()
	@RequirePermissions("park-lots.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.lots.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("park-lots.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.lots.get(session, id);
	}

	@Post()
	@RequirePermissions("park-lots.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.lots.create(session, parseDto(createParkLotDto, body));
	}

	@Patch(":id")
	@RequirePermissions("park-lots.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.lots.update(session, id, parseDto(updateParkLotDto, body));
	}

	@Delete(":id")
	@RequirePermissions("park-lots.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.lots.remove(session, id);
	}
}
