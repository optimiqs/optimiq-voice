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
import { createExtensionDto, updateExtensionDto } from "./extensions.dto";
import { ExtensionsService } from "./extensions.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/extensions`.
 *
 * A pure adapter (oikos §4): parse, delegate, return. The tenant is never a parameter — it comes
 * from the session inside the service — and the permission strings come from the registry in
 * `packages/auth`, which is the only supported place to introduce one.
 */
@Controller("api/v1/extensions")
export class ExtensionsController {
	constructor(@Inject(ExtensionsService) private readonly extensions: ExtensionsService) {}

	@Get()
	@RequirePermissions("extensions.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.extensions.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("extensions.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.extensions.get(session, id);
	}

	@Post()
	@RequirePermissions("extensions.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.extensions.create(session, parseDto(createExtensionDto, body));
	}

	@Patch(":id")
	@RequirePermissions("extensions.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.extensions.update(session, id, parseDto(updateExtensionDto, body));
	}

	@Delete(":id")
	@RequirePermissions("extensions.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.extensions.remove(session, id);
	}
}
