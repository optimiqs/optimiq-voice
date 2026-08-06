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
	createRingGroupDestinationDto,
	createRingGroupDto,
	updateRingGroupDestinationDto,
	updateRingGroupDto,
} from "./ring-groups.dto";
import { RingGroupDestinationsService, RingGroupsService } from "./ring-groups.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/ring-groups` and its nested `/destinations` (the members). */
@Controller("api/v1/ring-groups")
export class RingGroupsController {
	constructor(
		@Inject(RingGroupsService) private readonly groups: RingGroupsService,
		@Inject(RingGroupDestinationsService)
		private readonly members: RingGroupDestinationsService,
	) {}

	@Get()
	@RequirePermissions("ring-groups.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.groups.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("ring-groups.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.groups.get(session, id);
	}

	@Post()
	@RequirePermissions("ring-groups.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.groups.create(session, parseDto(createRingGroupDto, body));
	}

	@Patch(":id")
	@RequirePermissions("ring-groups.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.groups.update(session, id, parseDto(updateRingGroupDto, body));
	}

	@Delete(":id")
	@RequirePermissions("ring-groups.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.groups.remove(session, id);
	}

	// --- members -------------------------------------------------------------------------------

	@Get(":id/destinations")
	@RequirePermissions("ring-groups.read")
	async listMembers(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.members.list(session, id);
	}

	@Post(":id/destinations")
	@RequirePermissions("ring-groups.write")
	async createMember(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.members.create(session, id, parseDto(createRingGroupDestinationDto, body));
	}

	/**
	 * Replaces the members' order in one transaction.
	 *
	 * `PUT` rather than `PATCH` because the body is the complete order, not a delta — see
	 * `reorderDto`. A `sequential` group dials in ordinal order, so this is the difference between
	 * one recompile and N of them, each publishing an order nobody asked for.
	 */
	@Put(":id/destinations/reorder")
	@RequirePermissions("ring-groups.write")
	async reorderMembers(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.members.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/destinations/:destinationId")
	@RequirePermissions("ring-groups.write")
	async updateMember(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("destinationId", ParseUUIDPipe) destinationId: string,
		@Body() body: unknown,
	) {
		return await this.members.update(
			session,
			id,
			destinationId,
			parseDto(updateRingGroupDestinationDto, body),
		);
	}

	@Delete(":id/destinations/:destinationId")
	@RequirePermissions("ring-groups.write")
	async removeMember(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("destinationId", ParseUUIDPipe) destinationId: string,
	) {
		return await this.members.remove(session, id, destinationId);
	}
}
