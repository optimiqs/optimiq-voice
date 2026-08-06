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
import { createInboundRouteDto, updateInboundRouteDto } from "./inbound-routes.dto";
import { InboundRoutesService } from "./inbound-routes.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/inbound-routes`. */
@Controller("api/v1/inbound-routes")
export class InboundRoutesController {
	constructor(@Inject(InboundRoutesService) private readonly routes: InboundRoutesService) {}

	@Get()
	@RequirePermissions("routes.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.routes.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("routes.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.routes.get(session, id);
	}

	@Post()
	@RequirePermissions("routes.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.routes.create(session, parseDto(createInboundRouteDto, body));
	}

	@Patch(":id")
	@RequirePermissions("routes.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.routes.update(session, id, parseDto(updateInboundRouteDto, body));
	}

	@Delete(":id")
	@RequirePermissions("routes.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.routes.remove(session, id);
	}
}
