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
	createTranslationRuleDto,
	createTranslationRulesetDto,
	updateTranslationRuleDto,
	updateTranslationRulesetDto,
} from "./translations.dto";
import { TranslationRulesetsService, TranslationRulesService } from "./translations.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/translation-rulesets` and its ordered `/rules`.
 *
 * Guarded by `routes.*` and NOT by a resource of its own. A ruleset is only meaningful attached to
 * an outbound route or a trunk, and its power — deciding what digits reach which carrier — is the
 * power `routes.write` already grants. A `translations.*` trio would be three more names for one
 * decision, which is the field-level granularity the permission model exists to undo.
 */
@Controller("api/v1/translation-rulesets")
export class TranslationRulesetsController {
	constructor(
		@Inject(TranslationRulesetsService) private readonly rulesets: TranslationRulesetsService,
		@Inject(TranslationRulesService) private readonly rules: TranslationRulesService,
	) {}

	@Get()
	@RequirePermissions("routes.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.rulesets.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("routes.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.rulesets.get(session, id);
	}

	@Post()
	@RequirePermissions("routes.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.rulesets.create(session, parseDto(createTranslationRulesetDto, body));
	}

	@Patch(":id")
	@RequirePermissions("routes.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.rulesets.update(session, id, parseDto(updateTranslationRulesetDto, body));
	}

	@Delete(":id")
	@RequirePermissions("routes.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.rulesets.remove(session, id);
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
		return await this.rules.create(session, id, parseDto(createTranslationRuleDto, body));
	}

	/**
	 * Rewrites the pipeline's order in one transaction.
	 *
	 * The order IS the semantics here, more so than for any other ordered collection in this area: a
	 * ruleset is a pipeline where each rule sees the last one's output, so "strip the international
	 * prefix" before "add the plus" produces a number and the other way round produces nonsense.
	 * Rewriting it one PATCH at a time would publish every intermediate order to the routing cache,
	 * and the unique `(ruleset, ordinal)` index would refuse most of them anyway.
	 */
	@Put(":id/rules/reorder")
	@RequirePermissions("routes.write")
	async reorderRules(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.rules.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/rules/:ruleId")
	@RequirePermissions("routes.write")
	async updateRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ruleId", ParseUUIDPipe) ruleId: string,
		@Body() body: unknown,
	) {
		return await this.rules.update(session, id, ruleId, parseDto(updateTranslationRuleDto, body));
	}

	@Delete(":id/rules/:ruleId")
	@RequirePermissions("routes.delete")
	async removeRule(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("ruleId", ParseUUIDPipe) ruleId: string,
	) {
		return await this.rules.remove(session, id, ruleId);
	}
}
