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
 * Guarded by `time-conditions.*`, which the permission registry now carries. It borrowed `routes.*`
 * while it did not: that made "may edit a dial pattern" and "may move the holiday schedule" the
 * same grant, which is exactly the collapse the `<resource>.<action>` model exists to avoid — a
 * front-desk manager who should be able to shift opening hours had to be trusted with the outbound
 * dial plan to do it.
 */
@Controller("api/v1/time-conditions")
export class TimeConditionsController {
	constructor(
		@Inject(TimeConditionsService) private readonly conditions: TimeConditionsService,
		@Inject(TimeConditionRulesService) private readonly rules: TimeConditionRulesService,
	) {}

	@Get()
	@RequirePermissions("time-conditions.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.conditions.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("time-conditions.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conditions.get(session, id);
	}

	@Post()
	@RequirePermissions("time-conditions.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.conditions.create(session, parseDto(createTimeConditionDto, body));
	}

	@Patch(":id")
	@RequirePermissions("time-conditions.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.conditions.update(session, id, parseDto(updateTimeConditionDto, body));
	}

	@Delete(":id")
	@RequirePermissions("time-conditions.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conditions.remove(session, id);
	}

	// --- rules ---------------------------------------------------------------------------------

	@Get(":id/rules")
	@RequirePermissions("time-conditions.read")
	async listRules(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.rules.list(session, id);
	}

	@Post(":id/rules")
	@RequirePermissions("time-conditions.write")
	async createRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.rules.create(session, id, parseDto(createTimeConditionRuleDto, body));
	}

	/**
	 * Replaces the rules' order in one transaction.
	 *
	 * Ordinal is the semantics here in the strongest sense: the FIRST rule whose predicates all match
	 * wins, so moving a holiday above the weekday window is the whole edit.
	 */
	@Put(":id/rules/reorder")
	@RequirePermissions("time-conditions.write")
	async reorderRules(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.rules.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/rules/:ruleId")
	@RequirePermissions("time-conditions.write")
	async updateRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ruleId", ParseUUIDPipe) ruleId: string,
		@Body() body: unknown,
	) {
		return await this.rules.update(session, id, ruleId, parseDto(updateTimeConditionRuleDto, body));
	}

	@Delete(":id/rules/:ruleId")
	@RequirePermissions("time-conditions.write")
	async removeRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ruleId", ParseUUIDPipe) ruleId: string,
	) {
		return await this.rules.remove(session, id, ruleId);
	}
}
