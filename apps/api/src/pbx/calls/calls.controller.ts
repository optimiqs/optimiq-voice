import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { CallRecordingService } from "./call-recording.service";
import { emptyCallControlDto, originateCallDto } from "./calls.dto";
import { CallsService } from "./calls.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/calls`.
 *
 * Origination answers `201` rather than Nest's default because a call is a resource this request
 * brought into existence — the body names it, and the id is what every webhook about it will carry.
 * The recording controls answer `200`: they change a live call's state and create nothing.
 *
 * There is deliberately no `GET /api/v1/calls`, and no `DELETE /api/v1/calls/:id`. Live call state
 * is served by the live channel (`live-topics.ts`, `active-calls`) and the history by
 * `/api/v1/cdr`; a third view of the same facts would be a third thing to keep consistent.
 * Hanging a call up is a mid-call control operation the engine does not expose over HTTP at all yet
 * — see the `calls.originate` registry entry for why no permission was minted for it either. The
 * recording pause below is the first mid-call verb that DOES have an HTTP surface, and it has one
 * because a PCI pause is pressed by a person on a deadline; see `call-recording.service.ts` for the
 * one condition that limits which calls it can reach.
 */
@Controller("api/v1/calls")
export class CallsController {
	constructor(
		@Inject(CallsService) private readonly calls: CallsService,
		@Inject(CallRecordingService) private readonly recording: CallRecordingService,
	) {}

	@Post()
	@HttpCode(HttpStatus.CREATED)
	@RequirePermissions("calls.originate")
	async originate(@Session() session: AppSession, @Body() body: unknown) {
		const request = parseDto(originateCallDto, body);
		return { data: await this.calls.originate(session, request) };
	}

	/**
	 * The recording stops writing audio and keeps writing the file — what an agent presses before
	 * asking for a card number.
	 *
	 * `calls.control` and NOT `recordings.configure`, and the choice is worth stating because the
	 * name of the second one reads like a fit. `recordings.configure` is a power over POLICY — which
	 * calls are recorded, and for how long they are kept — held by whoever writes the tenant's
	 * retention rules, and it changes nothing that is happening right now. This is a mid-call verb on
	 * one live call, sent on the same subject and authorised by the same session as every other one,
	 * so it belongs with the grant that already means "take control of a live call". There is no
	 * `recordings.write` in the registry, and minting one for a surface `calls.control` already
	 * describes would be spending the permission ceiling on a synonym.
	 *
	 * There is no `.own` variant either, for the reason the registry's `calls` block records: no
	 * grant on this resource is scoped to the acting user. The scoping is TENANCY: the organization
	 * comes from this session and the call must be live in it, on both of the transports
	 * `call-recording.service.ts` uses — the session-verb channel for a call an application took, and
	 * `rpc.engine.v1.call-control` for every other call, which is where a PCI pause is actually
	 * pressed.
	 *
	 * `:id` is a CALL id, not a leg id, because that is what a webhook, the CDR and the live feed all
	 * carry — and it is deliberately all the caller has to know: which leg the recorder is attached
	 * to is the engine's own answer, not something a URL should be able to override.
	 */
	@Post(":id/recording/pause")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("calls.control")
	async pauseRecording(
		@Session() session: AppSession,
		@Param("id") id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyCallControlDto, body ?? {});
		return { data: await this.recording.setPaused(session, id, true) };
	}

	/** Audio resumes into the same file, after the silence. */
	@Post(":id/recording/resume")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("calls.control")
	async resumeRecording(
		@Session() session: AppSession,
		@Param("id") id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyCallControlDto, body ?? {});
		return { data: await this.recording.setPaused(session, id, false) };
	}
}
