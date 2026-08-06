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
	createTimeConditionDto,
	createTimeConditionRuleDto,
	updateTimeConditionDto,
	updateTimeConditionRuleDto,
} from "./time-conditions.dto";
import { TimeConditionRulesService, TimeConditionsService } from "./time-conditions.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/time-conditions` and its nested `/rules`.
 *
 * There is no `time-conditions.*` entry in the permission registry: a time condition is a routing
 * entity — it is authored on the same screen as the routes that gate on it and it changes where
 * calls go — so it is guarded by `routes.*`, the same as inbound and outbound routes. Adding a
 * permission is a change to `packages/auth`, which the Go track is reading from, so it is recorded
 * as a follow-up rather than done here.
 */
@Controller("api/v1/time-conditions")
export class TimeConditionsController {
	constructor(
		@Inject(TimeConditionsService) private readonly conditions: TimeConditionsService,
		@Inject(TimeConditionRulesService) private readonly rules: TimeConditionRulesService,
	) {}

	@Get()
	@RequirePermissions("routes.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.conditions.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("routes.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conditions.get(session, id);
	}

	@Post()
	@RequirePermissions("routes.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.conditions.create(session, parseDto(createTimeConditionDto, body));
	}

	@Patch(":id")
	@RequirePermissions("routes.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.conditions.update(session, id, parseDto(updateTimeConditionDto, body));
	}

	@Delete(":id")
	@RequirePermissions("routes.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conditions.remove(session, id);
	}

	// --- rules ---------------------------------------------------------------------------------

	@Get(":id/rules")
	@RequirePermissions("routes.read")
	async listRules(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.rules.list(session, id);
	}

	@Post(":id/rules")
	@RequirePermissions("routes.write")
	async createRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.rules.create(session, id, parseDto(createTimeConditionRuleDto, body));
	}

	@Patch(":id/rules/:ruleId")
	@RequirePermissions("routes.write")
	async updateRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ruleId", ParseUUIDPipe) ruleId: string,
		@Body() body: unknown,
	) {
		return await this.rules.update(session, id, ruleId, parseDto(updateTimeConditionRuleDto, body));
	}

	@Delete(":id/rules/:ruleId")
	@RequirePermissions("routes.write")
	async removeRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ruleId", ParseUUIDPipe) ruleId: string,
	) {
		return await this.rules.remove(session, id, ruleId);
	}
}
