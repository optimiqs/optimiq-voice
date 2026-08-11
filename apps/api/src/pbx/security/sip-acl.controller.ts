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
import { createSipAclEntryDto, updateSipAclEntryDto } from "./sip-acl.dto";
import { SipAclEntriesService } from "./sip-acl.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/sip-acl-entries`.
 *
 * Guarded by `security.*` rather than by `settings.*`. The argument is the one
 * `packages/auth/src/permissions.ts` already makes for `audit.read`: `settings.read` is held by
 * every self-service role so a user's own preferences screen renders, and the network allowlist
 * that decides which addresses may register phones or terminate calls is not a preference. Write
 * access here is the ability to open the platform to an arbitrary network, which is the same
 * privilege class as issuing credentials.
 */
@Controller("api/v1/sip-acl-entries")
export class SipAclEntriesController {
	constructor(@Inject(SipAclEntriesService) private readonly entries: SipAclEntriesService) {}

	@Get()
	@RequirePermissions("security.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.entries.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("security.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.entries.get(session, id);
	}

	@Post()
	@RequirePermissions("security.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.entries.create(session, parseDto(createSipAclEntryDto, body));
	}

	@Patch(":id")
	@RequirePermissions("security.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.entries.update(session, id, parseDto(updateSipAclEntryDto, body));
	}

	@Delete(":id")
	@RequirePermissions("security.write")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.entries.remove(session, id);
	}
}
