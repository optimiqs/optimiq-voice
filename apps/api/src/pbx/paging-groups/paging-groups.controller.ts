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
	createPagingGroupDto,
	createPagingGroupMemberDto,
	updatePagingGroupDto,
	updatePagingGroupMemberDto,
} from "./paging-groups.dto";
import { PagingGroupMembersService, PagingGroupsService } from "./paging-groups.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/paging-groups` and its nested `/members` (the handsets an announcement reaches). */
@Controller("api/v1/paging-groups")
export class PagingGroupsController {
	constructor(
		@Inject(PagingGroupsService) private readonly groups: PagingGroupsService,
		@Inject(PagingGroupMembersService)
		private readonly members: PagingGroupMembersService,
	) {}

	@Get()
	@RequirePermissions("paging-groups.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.groups.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("paging-groups.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.groups.get(session, id);
	}

	@Post()
	@RequirePermissions("paging-groups.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.groups.create(session, parseDto(createPagingGroupDto, body));
	}

	@Patch(":id")
	@RequirePermissions("paging-groups.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.groups.update(session, id, parseDto(updatePagingGroupDto, body));
	}

	@Delete(":id")
	@RequirePermissions("paging-groups.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.groups.remove(session, id);
	}

	// --- members -------------------------------------------------------------------------------

	@Get(":id/members")
	@RequirePermissions("paging-groups.read")
	async listMembers(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.members.list(session, id);
	}

	@Post(":id/members")
	@RequirePermissions("paging-groups.write")
	async createMember(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.members.create(session, id, parseDto(createPagingGroupMemberDto, body));
	}

	/**
	 * Replaces the fan-out order in one transaction.
	 *
	 * `PUT` rather than `PATCH` for the reason `reorderDto` states: the body is the complete order,
	 * not a delta. An announcement to a hundred handsets is originated in the order the operator
	 * chose, so rewriting that order one PATCH at a time would publish N intermediate orders to the
	 * routing cache — and `paging_group_member` has a unique `(group, ordinal)` index, so most of
	 * those intermediate states would not even be writable without the caller shuffling around it.
	 */
	@Put(":id/members/reorder")
	@RequirePermissions("paging-groups.write")
	async reorderMembers(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.members.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/members/:memberId")
	@RequirePermissions("paging-groups.write")
	async updateMember(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("memberId", ParseUUIDPipe) memberId: string,
		@Body() body: unknown,
	) {
		return await this.members.update(
			session,
			id,
			memberId,
			parseDto(updatePagingGroupMemberDto, body),
		);
	}

	@Delete(":id/members/:memberId")
	@RequirePermissions("paging-groups.write")
	async removeMember(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("memberId", ParseUUIDPipe) memberId: string,
	) {
		return await this.members.remove(session, id, memberId);
	}
}
