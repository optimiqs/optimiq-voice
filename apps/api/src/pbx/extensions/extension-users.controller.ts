import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod/v4";
import { EXTENSION_USER_ROLES } from "@optimiq-voice/pbx-db";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { ExtensionUsersService } from "./extension-users.service";
import type { AppSession } from "@optimiq-voice/auth";

export const assignExtensionUserDto = z.strictObject({
	userId: z.uuid(),
	role: z.enum(EXTENSION_USER_ROLES).default("primary"),
});

@Controller("api/v1/extensions/:id/users")
@RequirePermissions("extensions.assign")
export class ExtensionUsersController {
	constructor(@Inject(ExtensionUsersService) private readonly users: ExtensionUsersService) {}

	@Get()
	async list(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.users.list(session, id);
	}

	@Post()
	async create(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.users.create(session, id, parseDto(assignExtensionUserDto, body));
	}

	@Delete(":assignmentId")
	async remove(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("assignmentId", ParseUUIDPipe) assignmentId: string,
	) {
		return await this.users.remove(session, id, assignmentId);
	}
}
