import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	ParseUUIDPipe,
	Optional,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import { QueueCallbacksClient } from "./queue-callbacks.client";
import {
	createQueueAgentDto,
	createQueueAgentSkillDto,
	createQueueDispositionCodeDto,
	createQueueDto,
	createQueueSkillRequirementDto,
	createQueueSurveyQuestionDto,
	createQueueTierDto,
	updateQueueAgentDto,
	updateQueueAgentSkillDto,
	updateQueueDispositionCodeDto,
	updateQueueDto,
	updateQueueSkillRequirementDto,
	updateQueueSurveyQuestionDto,
	updateQueueTierDto,
} from "./queues.dto";
import {
	QueueAgentSkillsService,
	QueueAgentsService,
	QueueDispositionCodesService,
	QueueSkillRequirementsService,
	QueueSurveyQuestionsService,
	QueueTiersService,
	QueuesService,
} from "./queues.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/queues` and its nested `/tiers` (the agent memberships).
 *
 * The tier endpoints are guarded by `queues.manage-agents` rather than `queues.write`, because that
 * is precisely what the permission was registered to mean: a supervisor who staffs the queues is
 * not necessarily the person who changes their announcements and overflow behaviour, and collapsing
 * the two would make "may staff the floor" imply "may re-point the overflow at an external number".
 */
@Controller("api/v1/queues")
export class QueuesController {
	constructor(
		@Inject(QueuesService) private readonly queues: QueuesService,
		@Inject(QueueTiersService) private readonly tiers: QueueTiersService,
		@Inject(QueueDispositionCodesService)
		private readonly dispositionCodes: QueueDispositionCodesService,
		@Inject(QueueSkillRequirementsService)
		private readonly skillRequirements: QueueSkillRequirementsService,
		@Inject(QueueSurveyQuestionsService)
		private readonly surveyQuestions: QueueSurveyQuestionsService,
		@Optional()
		@Inject(QueueCallbacksClient)
		private readonly callbacks?: QueueCallbacksClient,
	) {}

	@Get()
	@RequirePermissions("queues.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.queues.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("queues.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.queues.get(session, id);
	}

	@Post()
	@RequirePermissions("queues.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.queues.create(session, parseDto(createQueueDto, body));
	}

	@Patch(":id")
	@RequirePermissions("queues.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.queues.update(session, id, parseDto(updateQueueDto, body));
	}

	@Delete(":id")
	@RequirePermissions("queues.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.queues.remove(session, id);
	}

	/**
	 * The callbacks this queue still owes.
	 *
	 * `queues.read`, the same grant the queue itself is behind: a pending callback is the queue's
	 * own state and says nothing an operator who may read the queue may not see. The queue is
	 * fetched first, so an id from another tenant or one that never existed is a 404 before the
	 * bucket is touched — the tenancy check, not a nicety.
	 */
	@Get(":id/callbacks")
	@RequirePermissions("queues.read")
	async listCallbacks(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		const queue = await this.queues.get(session, id);
		const organizationId = queue.data.organizationId;
		return {
			data:
				typeof organizationId === "string"
					? ((await this.callbacks?.pendingFor(organizationId, id)) ?? [])
					: [],
		};
	}

	// --- tiers ---------------------------------------------------------------------------------

	@Get(":id/tiers")
	@RequirePermissions("queues.read")
	async listTiers(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.tiers.list(session, id);
	}

	@Post(":id/tiers")
	@RequirePermissions("queues.manage-agents")
	async createTier(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.tiers.create(session, id, parseDto(createQueueTierDto, body));
	}

	@Patch(":id/tiers/:tierId")
	@RequirePermissions("queues.manage-agents")
	async updateTier(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("tierId", ParseUUIDPipe) tierId: string,
		@Body() body: unknown,
	) {
		return await this.tiers.update(session, id, tierId, parseDto(updateQueueTierDto, body));
	}

	@Delete(":id/tiers/:tierId")
	@RequirePermissions("queues.manage-agents")
	async removeTier(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("tierId", ParseUUIDPipe) tierId: string,
	) {
		return await this.tiers.remove(session, id, tierId);
	}

	// --- disposition codes ---------------------------------------------------------------------
	//
	// `queues.write` to mutate and `queues.read` to list, NOT the tiers' `queues.manage-agents`:
	// the vocabulary is what the queue asks about its own calls, which is the same kind of decision
	// as its announcements. Who staffs the floor is the other permission and the other collection.

	@Get(":id/disposition-codes")
	@RequirePermissions("queues.read")
	async listDispositionCodes(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
	) {
		return await this.dispositionCodes.list(session, id);
	}

	@Post(":id/disposition-codes")
	@RequirePermissions("queues.write")
	async createDispositionCode(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.dispositionCodes.create(
			session,
			id,
			parseDto(createQueueDispositionCodeDto, body),
		);
	}

	@Patch(":id/disposition-codes/:codeId")
	@RequirePermissions("queues.write")
	async updateDispositionCode(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("codeId", ParseUUIDPipe) codeId: string,
		@Body() body: unknown,
	) {
		return await this.dispositionCodes.update(
			session,
			id,
			codeId,
			parseDto(updateQueueDispositionCodeDto, body),
		);
	}

	@Delete(":id/disposition-codes/:codeId")
	@RequirePermissions("queues.write")
	async removeDispositionCode(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("codeId", ParseUUIDPipe) codeId: string,
	) {
		return await this.dispositionCodes.remove(session, id, codeId);
	}

	// --- skill requirements --------------------------------------------------------------------

	@Get(":id/skill-requirements")
	@RequirePermissions("queues.read")
	async listSkillRequirements(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
	) {
		return await this.skillRequirements.list(session, id);
	}

	@Post(":id/skill-requirements")
	@RequirePermissions("queues.write")
	async createSkillRequirement(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.skillRequirements.create(
			session,
			id,
			parseDto(createQueueSkillRequirementDto, body),
		);
	}

	@Patch(":id/skill-requirements/:requirementId")
	@RequirePermissions("queues.write")
	async updateSkillRequirement(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("requirementId", ParseUUIDPipe) requirementId: string,
		@Body() body: unknown,
	) {
		return await this.skillRequirements.update(
			session,
			id,
			requirementId,
			parseDto(updateQueueSkillRequirementDto, body),
		);
	}

	@Delete(":id/skill-requirements/:requirementId")
	@RequirePermissions("queues.write")
	async removeSkillRequirement(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("requirementId", ParseUUIDPipe) requirementId: string,
	) {
		return await this.skillRequirements.remove(session, id, requirementId);
	}

	// --- survey questions ----------------------------------------------------------------------

	@Get(":id/survey-questions")
	@RequirePermissions("queues.read")
	async listSurveyQuestions(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
	) {
		return await this.surveyQuestions.list(session, id);
	}

	/**
	 * At most three, at positions 1 to 3.
	 *
	 * The ceiling is the database's — the position check and the unique index on
	 * `(organization_id, queue_id, position)` between them make a fourth question impossible to
	 * insert, whatever this handler believes. So there is no count read here: a check-then-insert
	 * would be a race two supervisors could both win, and the constraint refuses one of them
	 * regardless. The DTO's own `position` bound is what turns the common case into a 400 with a
	 * field on it rather than a constraint name.
	 */
	@Post(":id/survey-questions")
	@RequirePermissions("queues.write")
	async createSurveyQuestion(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.surveyQuestions.create(
			session,
			id,
			parseDto(createQueueSurveyQuestionDto, body),
		);
	}

	@Patch(":id/survey-questions/:questionId")
	@RequirePermissions("queues.write")
	async updateSurveyQuestion(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("questionId", ParseUUIDPipe) questionId: string,
		@Body() body: unknown,
	) {
		return await this.surveyQuestions.update(
			session,
			id,
			questionId,
			parseDto(updateQueueSurveyQuestionDto, body),
		);
	}

	@Delete(":id/survey-questions/:questionId")
	@RequirePermissions("queues.write")
	async removeSurveyQuestion(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("questionId", ParseUUIDPipe) questionId: string,
	) {
		return await this.surveyQuestions.remove(session, id, questionId);
	}
}

/**
 * `/api/v1/queue-agents`.
 *
 * Top-level rather than nested, because `queue_agent` carries no queue: one agent serves several
 * queues through `queue_tier`. See `queues.resource.ts`.
 */
@Controller("api/v1/queue-agents")
export class QueueAgentsController {
	constructor(
		@Inject(QueueAgentsService) private readonly agents: QueueAgentsService,
		@Inject(QueueAgentSkillsService) private readonly skills: QueueAgentSkillsService,
	) {}

	@Get()
	@RequirePermissions("queues.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.agents.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("queues.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.agents.get(session, id);
	}

	@Post()
	@RequirePermissions("queues.manage-agents")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.agents.create(session, parseDto(createQueueAgentDto, body));
	}

	@Patch(":id")
	@RequirePermissions("queues.manage-agents")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.agents.update(session, id, parseDto(updateQueueAgentDto, body));
	}

	@Delete(":id")
	@RequirePermissions("queues.manage-agents")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.agents.remove(session, id);
	}

	// --- skills --------------------------------------------------------------------------------
	//
	// `queues.manage-agents` to mutate, matching the rest of this controller and the tiers: what a
	// person can do is a staffing fact, and it decides who is offered which caller once a queue
	// carries a skill requirement.

	@Get(":id/skills")
	@RequirePermissions("queues.read")
	async listSkills(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.skills.list(session, id);
	}

	@Post(":id/skills")
	@RequirePermissions("queues.manage-agents")
	async createSkill(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.skills.create(session, id, parseDto(createQueueAgentSkillDto, body));
	}

	@Patch(":id/skills/:skillId")
	@RequirePermissions("queues.manage-agents")
	async updateSkill(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("skillId", ParseUUIDPipe) skillId: string,
		@Body() body: unknown,
	) {
		return await this.skills.update(session, id, skillId, parseDto(updateQueueAgentSkillDto, body));
	}

	@Delete(":id/skills/:skillId")
	@RequirePermissions("queues.manage-agents")
	async removeSkill(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("skillId", ParseUUIDPipe) skillId: string,
	) {
		return await this.skills.remove(session, id, skillId);
	}
}
