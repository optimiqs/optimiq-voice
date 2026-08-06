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
	createQueueAgentDto,
	createQueueDto,
	createQueueTierDto,
	updateQueueAgentDto,
	updateQueueDto,
	updateQueueTierDto,
} from "./queues.dto";
import { QueueAgentsService, QueueTiersService, QueuesService } from "./queues.service";
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
}

/**
 * `/api/v1/queue-agents`.
 *
 * Top-level rather than nested, because `queue_agent` carries no queue: one agent serves several
 * queues through `queue_tier`. See `queues.resource.ts`.
 */
@Controller("api/v1/queue-agents")
export class QueueAgentsController {
	constructor(@Inject(QueueAgentsService) private readonly agents: QueueAgentsService) {}

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
}
