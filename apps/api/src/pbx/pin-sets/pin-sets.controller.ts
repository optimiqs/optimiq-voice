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
import { z } from "zod/v4";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto, reorderDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import {
	createPinSetDto,
	createPinSetEntryDto,
	setPinDto,
	updatePinSetDto,
	updatePinSetEntryDto,
} from "./pin-sets.dto";
import { PinSetEntriesService, PinSetsService } from "./pin-sets.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The create body for a code: its metadata plus the code itself, in one request.
 *
 * Merged here rather than in `pin-sets.dto.ts` because it is a shape only this controller uses — the
 * table has no `pin` column, and a DTO named after one would invite somebody to add it.
 */
const createEntryWithPinDto = createPinSetEntryDto.extend(setPinDto.shape);

/** `/api/v1/pin-sets` and its ordered `/entries`. */
@Controller("api/v1/pin-sets")
export class PinSetsController {
	constructor(
		@Inject(PinSetsService) private readonly sets: PinSetsService,
		@Inject(PinSetEntriesService) private readonly entries: PinSetEntriesService,
	) {}

	@Get()
	@RequirePermissions("pin-sets.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.sets.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("pin-sets.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.sets.get(session, id);
	}

	@Post()
	@RequirePermissions("pin-sets.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.sets.create(session, parseDto(createPinSetDto, body));
	}

	@Patch(":id")
	@RequirePermissions("pin-sets.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.sets.update(session, id, parseDto(updatePinSetDto, body));
	}

	@Delete(":id")
	@RequirePermissions("pin-sets.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.sets.remove(session, id);
	}

	// --- entries -------------------------------------------------------------------------------

	@Get(":id/entries")
	@RequirePermissions("pin-sets.read")
	async listEntries(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.entries.list(session, id);
	}

	/**
	 * Creates a code and its digest together.
	 *
	 * One request rather than create-then-set, because a code with no digest is a row the compiler
	 * drops with a warning: a two-step flow would leave a window in which the set looks configured
	 * on screen and gates nothing on the wire.
	 */
	@Post(":id/entries")
	@RequirePermissions("pin-sets.write")
	async createEntry(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		const parsed = parseDto(createEntryWithPinDto, body);
		const { pin, ...values } = parsed as z.infer<typeof createEntryWithPinDto>;
		return await this.entries.createWithPin(session, id, values, pin);
	}

	@Put(":id/entries/reorder")
	@RequirePermissions("pin-sets.write")
	async reorderEntries(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.entries.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/entries/:entryId")
	@RequirePermissions("pin-sets.write")
	async updateEntry(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("entryId", ParseUUIDPipe) entryId: string,
		@Body() body: unknown,
	) {
		return await this.entries.update(session, id, entryId, parseDto(updatePinSetEntryDto, body));
	}

	/**
	 * Replaces one code's digits.
	 *
	 * `PUT` and a route of its own, exactly as a mailbox PIN is set: the value is hashed on the way
	 * in and never comes back, so a field on the PATCH would make "did that save?" a question the
	 * response cannot answer. The ordinal and the label — what a CDR records — are untouched, which
	 * is what keeps every historical "authorised by code 3" pointing at the same code.
	 */
	@Put(":id/entries/:entryId/pin")
	@RequirePermissions("pin-sets.write")
	async setEntryPin(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("entryId", ParseUUIDPipe) entryId: string,
		@Body() body: unknown,
	) {
		return await this.entries.setPin(session, id, entryId, parseDto(setPinDto, body).pin);
	}

	@Delete(":id/entries/:entryId")
	@RequirePermissions("pin-sets.delete")
	async removeEntry(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("entryId", ParseUUIDPipe) entryId: string,
	) {
		return await this.entries.remove(session, id, entryId);
	}
}
