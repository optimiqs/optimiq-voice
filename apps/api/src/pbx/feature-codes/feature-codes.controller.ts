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
import {
	createFeatureCodeDto,
	FEATURE_CODE_PARAM_FIELDS,
	updateFeatureCodeDto,
} from "./feature-codes.dto";
import { FeatureCodesService } from "./feature-codes.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/feature-codes`.
 *
 * Guarded by `feature-codes.*`. It borrowed `routes.*` while the registry had no entry of its own,
 * which made renumbering `*97` and rewriting the outbound dial plan the same grant.
 */
@Controller("api/v1/feature-codes")
export class FeatureCodesController {
	constructor(@Inject(FeatureCodesService) private readonly codes: FeatureCodesService) {}

	/**
	 * What each action's `params` accepts, so the form renders a control instead of a JSON box.
	 *
	 * Declared before `@Get(":id")` — Nest matches in declaration order, and `param-fields` is a
	 * literal, not a uuid. Static data, so it needs a session and `feature-codes.read` and nothing
	 * else: it describes the schema, not the tenant.
	 */
	@Get("param-fields")
	@RequirePermissions("feature-codes.read")
	paramFields() {
		return { data: FEATURE_CODE_PARAM_FIELDS };
	}

	@Get()
	@RequirePermissions("feature-codes.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.codes.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("feature-codes.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.codes.get(session, id);
	}

	@Post()
	@RequirePermissions("feature-codes.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.codes.create(session, parseDto(createFeatureCodeDto, body));
	}

	@Patch(":id")
	@RequirePermissions("feature-codes.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.codes.update(session, id, parseDto(updateFeatureCodeDto, body));
	}

	@Delete(":id")
	@RequirePermissions("feature-codes.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.codes.remove(session, id);
	}
}
