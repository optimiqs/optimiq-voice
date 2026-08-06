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
import { createFeatureCodeDto, updateFeatureCodeDto } from "./feature-codes.dto";
import { FeatureCodesService } from "./feature-codes.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/feature-codes`.
 *
 * Guarded by `routes.*` for the same reason time conditions are: a feature code is a routing entry
 * in the internal context, and the registry has no `feature-codes.*` entry yet.
 */
@Controller("api/v1/feature-codes")
export class FeatureCodesController {
	constructor(@Inject(FeatureCodesService) private readonly codes: FeatureCodesService) {}

	@Get()
	@RequirePermissions("routes.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.codes.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("routes.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.codes.get(session, id);
	}

	@Post()
	@RequirePermissions("routes.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.codes.create(session, parseDto(createFeatureCodeDto, body));
	}

	@Patch(":id")
	@RequirePermissions("routes.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.codes.update(session, id, parseDto(updateFeatureCodeDto, body));
	}

	@Delete(":id")
	@RequirePermissions("routes.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.codes.remove(session, id);
	}
}
