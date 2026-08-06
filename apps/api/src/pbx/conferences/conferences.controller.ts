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
import { ConferencePinService } from "./conference-pin.service";
import { createConferenceDto, setConferencePinDto, updateConferenceDto } from "./conferences.dto";
import { ConferencesService } from "./conferences.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/conferences`.
 *
 * `conferences.moderate` is not used here: it governs a LIVE room — mute, kick, lock, record — and
 * that surface belongs to the engine, not to the configuration CRUD. Guarding a room's settings
 * with it would let anyone who can mute a participant re-point the room's recording policy.
 */
@Controller("api/v1/conferences")
export class ConferencesController {
	constructor(
		@Inject(ConferencesService) private readonly conferences: ConferencesService,
		@Inject(ConferencePinService) private readonly pins: ConferencePinService,
	) {}

	@Get()
	@RequirePermissions("conferences.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.conferences.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("conferences.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conferences.get(session, id);
	}

	@Post()
	@RequirePermissions("conferences.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.conferences.create(session, parseDto(createConferenceDto, body));
	}

	@Patch(":id")
	@RequirePermissions("conferences.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.conferences.update(session, id, parseDto(updateConferenceDto, body));
	}

	@Delete(":id")
	@RequirePermissions("conferences.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.conferences.remove(session, id);
	}

	// -------------------------------------------------------------------------------------------
	// The PINs
	// -------------------------------------------------------------------------------------------

	/**
	 * Sets the room's participant PIN — the endpoint `conferences.resource.ts` has been promising
	 * since the resource was declared, and the reason `requiresPin` in the compiled artifact can
	 * finally be true.
	 *
	 * `conferences.write` and not a new permission: setting a PIN is configuring a room, and the
	 * registry is at its documented ceiling. It is a distinct ROUTE rather than a field on `PATCH`
	 * because the value is a secret with a lifecycle — hashed on arrival, never read back, never
	 * echoed — and a `PATCH` body that sometimes contains a plaintext PIN is a `PATCH` body that
	 * ends up in a debug log.
	 *
	 * Explicitly NOT `conferences.moderate`, even for the moderator PIN below. That permission
	 * governs a LIVE room — mute, kick, lock, record — and guarding a stored credential with it
	 * would let anyone who can mute a participant change how the room is entered.
	 */
	@Post(":id/pin")
	@RequirePermissions("conferences.write")
	async setPin(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		const { pin } = parseDto(setConferencePinDto, body);
		return await this.pins.set(session, id, "participant", pin);
	}

	@Delete(":id/pin")
	@RequirePermissions("conferences.write")
	async clearPin(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.pins.clear(session, id, "participant");
	}

	/**
	 * Sets the room's moderator PIN.
	 *
	 * Stored, hashed in the same format, and — today — read by nothing. `ConferenceInput` in
	 * `packages/routing` has no moderator field, so the loader has nowhere to put it and the
	 * recompile this triggers produces an identical `snapshotHash`. The endpoint exists anyway
	 * because the column exists, because the digest is the expensive half to get right, and
	 * because the alternative is a UI that cannot express a configuration the schema models. See
	 * `conference-pin.service.ts` for the exact list of what does and does not reach the engine.
	 */
	@Post(":id/moderator-pin")
	@RequirePermissions("conferences.write")
	async setModeratorPin(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		const { pin } = parseDto(setConferencePinDto, body);
		return await this.pins.set(session, id, "moderator", pin);
	}

	@Delete(":id/moderator-pin")
	@RequirePermissions("conferences.write")
	async clearModeratorPin(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.pins.clear(session, id, "moderator");
	}
}
