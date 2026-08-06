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
	createVoicemailBoxDto,
	setVoicemailPinDto,
	updateVoicemailBoxDto,
} from "./voicemail-boxes.dto";
import { VoicemailBoxesService } from "./voicemail-boxes.service";
import { VoicemailPinService } from "./voicemail-pin.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/voicemail-boxes` — mailbox configuration, not its messages.
 *
 * The contents live on `voicemail-messages.controller.ts`, under the same prefix and with a
 * different lifecycle: this controller's writes are routing changes that recompile the tenant's
 * artifact, and a message move is not a routing input at all.
 */
@Controller("api/v1/voicemail-boxes")
export class VoicemailBoxesController {
	constructor(
		@Inject(VoicemailBoxesService) private readonly boxes: VoicemailBoxesService,
		@Inject(VoicemailPinService) private readonly pins: VoicemailPinService,
	) {}

	@Get()
	@RequirePermissions("voicemail.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.boxes.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("voicemail.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.boxes.get(session, id);
	}

	@Post()
	@RequirePermissions("voicemail.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.boxes.create(session, parseDto(createVoicemailBoxDto, body));
	}

	@Patch(":id")
	@RequirePermissions("voicemail.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.boxes.update(session, id, parseDto(updateVoicemailBoxDto, body));
	}

	@Delete(":id")
	@RequirePermissions("voicemail.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.boxes.remove(session, id);
	}

	/**
	 * Sets the mailbox's PIN — the endpoint `packages/routing` §3.1 was written against and the
	 * one `voicemail-boxes.resource.ts` has been promising since the resource was declared.
	 *
	 * `voicemail.write` and not a new permission: setting a PIN is editing a mailbox, and the
	 * registry is at its documented ceiling. It is a distinct ROUTE rather than a field on `PATCH`
	 * because the value is a secret with a lifecycle — hashed on arrival, never read back, never
	 * echoed — and a `PATCH` body that sometimes contains a plaintext PIN is a `PATCH` body that
	 * ends up in a debug log.
	 *
	 * A `POST` on an existing PIN replaces it. There is no "verify the old one first" step: this is
	 * an administrator resetting somebody else's mailbox, not a user changing their own, and
	 * demanding a PIN the administrator does not know would make the endpoint useless for the case
	 * it exists to serve. Self-service PIN change belongs to `*97`, on the engine's side, where the
	 * caller has already authenticated with the old one.
	 */
	@Post(":id/pin")
	@RequirePermissions("voicemail.write")
	async setPin(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		const { pin } = parseDto(setVoicemailPinDto, body);
		return await this.pins.set(session, id, pin);
	}

	/**
	 * Clears it.
	 *
	 * The mailbox falls back to authenticating by the calling extension, which is what it did
	 * before a PIN was ever set — so this is a downgrade, not a lockout, and it is why it is a
	 * `voicemail.write` rather than a `voicemail.delete`: nothing is destroyed but a credential.
	 */
	@Delete(":id/pin")
	@RequirePermissions("voicemail.write")
	async clearPin(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.pins.clear(session, id);
	}
}
