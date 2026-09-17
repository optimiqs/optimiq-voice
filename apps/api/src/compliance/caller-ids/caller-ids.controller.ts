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
import { parseDto } from "../../pbx/shared/dto";
import { listQuerySchema } from "../../pbx/shared/pagination";
import { createVerifiedCallerIdDto, updateVerifiedCallerIdDto } from "./caller-ids.dto";
import { VerifiedCallerIdsService } from "./caller-ids.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/compliance/caller-ids` — the numbers this tenant may present.
 *
 * | Route                       | Permission          |
 * | --------------------------- | ------------------- |
 * | `GET`                       | `compliance.read`   |
 * | `POST` / `PATCH` / `DELETE` | `compliance.write`  |
 *
 * Reads are the narrower-audience permission and writes the narrower one, split the same way
 * `emergency-addresses.controller.ts` splits `numbers.read` from `numbers.emergency`: a role that
 * can see which numbers are verified but not verify one is a useful role (support, billing), and a
 * role that can verify one is asserting a right-to-use on the tenant's behalf.
 */
@Controller("api/v1/compliance/caller-ids")
export class VerifiedCallerIdsController {
	constructor(
		@Inject(VerifiedCallerIdsService) private readonly callerIds: VerifiedCallerIdsService,
	) {}

	@Get()
	@RequirePermissions("compliance.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.callerIds.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("compliance.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.callerIds.get(session, id);
	}

	@Post()
	@RequirePermissions("compliance.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.callerIds.create(session, parseDto(createVerifiedCallerIdDto, body));
	}

	@Patch(":id")
	@RequirePermissions("compliance.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.callerIds.update(session, id, parseDto(updateVerifiedCallerIdDto, body));
	}

	/**
	 * Removes a verification.
	 *
	 * A hard delete and not a tombstone, which is the one place this slice differs from what a
	 * compliance reflex would ask for. The evidentiary record of "this number was verified on this
	 * date by this person" is in `audit_log`, which is append-only and outlives the row; keeping a
	 * soft-deleted row here as well would give the attestation compiler a second state to interpret
	 * ("does a deleted verification still confer a right to use?") for no gain.
	 */
	@Delete(":id")
	@RequirePermissions("compliance.write")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.callerIds.remove(session, id);
	}
}
