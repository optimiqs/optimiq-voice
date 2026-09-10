import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { Session } from "../auth/session.decorator";
import { parseDto } from "../pbx/shared/dto";
import { listQuerySchema } from "../pbx/shared/pagination";
import { MessagingRegistrationService } from "./messaging-registration.service";
import {
	assignCampaignNumberDto,
	createBrandDto,
	createCampaignDto,
	submitTollFreeVerificationDto,
	updateCampaignDto,
	verifyBrandOtpDto,
} from "./messaging.dto";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/messaging` — the A2P registration half: brands, campaigns, and toll-free verification.
 *
 * ## A second controller on the same prefix
 *
 * `MessagingController` owns `numbers`, `conversations`, `messages`, `media` and `opt-outs` under the
 * same prefix; this one owns `brands`, `campaigns` and `toll-free-verifications`. Nest merges the
 * two into one router, and the segment sets are disjoint, so nothing here can shadow anything there.
 * Neither controller declares a parametric route at the prefix root — a `GET :id` on either would
 * silently claim the other's literals in a router that resolved parametrics first, and relying on
 * `find-my-way` preferring statics to keep two FILES from colliding is a coupling neither file can
 * see. The split is by lifecycle: registration is a days-long conversation with a registry, and
 * everything in the other controller answers in milliseconds.
 *
 * ## The permissions
 *
 * Reads are `messaging.read`; every submission, PIN, assignment and detach is `messaging.manage`.
 * There is no separate `register` grant, deliberately: unlike a send, none of these acts spends
 * money per call in a way an operator would want to delegate independently — they are all "configure
 * how this tenant is allowed to message", which is one job.
 */
@Controller("api/v1/messaging")
export class MessagingRegistrationController {
	constructor(
		@Inject(MessagingRegistrationService)
		private readonly registration: MessagingRegistrationService,
	) {}

	// ---- 10DLC brands ------------------------------------------------------------------------

	@Get("brands")
	@RequirePermissions("messaging.read")
	async listBrands(@Session() session: AppSession, @Query() query: unknown) {
		return await this.registration.listBrands(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get("brands/:id")
	@RequirePermissions("messaging.read")
	async getBrand(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.registration.getBrand(session, id);
	}

	/**
	 * Files a brand with the registry.
	 *
	 * `202`, not `201`: what exists afterwards is a SUBMISSION under vetting, and TCR's answer arrives
	 * minutes to days later through the poller. A `201` would tell an integrator the brand is usable.
	 */
	@Post("brands")
	@HttpCode(HttpStatus.ACCEPTED)
	@RequirePermissions("messaging.manage")
	async createBrand(@Session() session: AppSession, @Body() body: unknown) {
		return await this.registration.createBrand(session, parseDto(createBrandDto, body ?? {}));
	}

	/** Sends the sole-proprietor SMS PIN. `POST` because it dispatches a real message to a person. */
	@Post("brands/:id/otp")
	@RequirePermissions("messaging.manage")
	async triggerBrandOtp(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.registration.triggerBrandOtp(session, id);
	}

	@Post("brands/:id/otp/verify")
	@RequirePermissions("messaging.manage")
	async verifyBrandOtp(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.registration.verifyBrandOtp(
			session,
			id,
			parseDto(verifyBrandOtpDto, body ?? {}),
		);
	}

	// ---- 10DLC campaigns ---------------------------------------------------------------------

	@Get("campaigns")
	@RequirePermissions("messaging.read")
	async listCampaigns(@Session() session: AppSession, @Query() query: unknown) {
		return await this.registration.listCampaigns(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get("campaigns/:id")
	@RequirePermissions("messaging.read")
	async getCampaign(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.registration.getCampaign(session, id);
	}

	/** `202` for the same reason as the brand: the registry has not decided yet. */
	@Post("campaigns")
	@HttpCode(HttpStatus.ACCEPTED)
	@RequirePermissions("messaging.manage")
	async createCampaign(@Session() session: AppSession, @Body() body: unknown) {
		return await this.registration.createCampaign(session, parseDto(createCampaignDto, body ?? {}));
	}

	@Patch("campaigns/:id")
	@RequirePermissions("messaging.manage")
	async updateCampaign(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.registration.updateCampaign(
			session,
			id,
			parseDto(updateCampaignDto, body ?? {}),
		);
	}

	/**
	 * Attaches a number to the campaign.
	 *
	 * Nested under the campaign rather than hung off the number, because the campaign is what the
	 * carriers key the assignment on and what an admin is looking at when they do this. The response
	 * is the NUMBER, since its registration state is the thing that changed.
	 */
	@Post("campaigns/:id/numbers")
	@RequirePermissions("messaging.manage")
	async assignNumber(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.registration.assignNumber(
			session,
			id,
			parseDto(assignCampaignNumberDto, body ?? {}),
		);
	}

	@Delete("campaigns/:id/numbers/:messagingNumberId")
	@RequirePermissions("messaging.manage")
	async unassignNumber(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("messagingNumberId", ParseUUIDPipe) messagingNumberId: string,
	) {
		return await this.registration.unassignNumber(session, id, messagingNumberId);
	}

	// ---- toll-free verification --------------------------------------------------------------

	@Get("toll-free-verifications")
	@RequirePermissions("messaging.read")
	async listTollFreeVerifications(@Session() session: AppSession, @Query() query: unknown) {
		return await this.registration.listTollFreeVerifications(
			session,
			parseDto(listQuerySchema, query ?? {}),
		);
	}

	/** `202`: the aggregators review this by hand, and the poller carries the verdict back. */
	@Post("toll-free-verifications")
	@HttpCode(HttpStatus.ACCEPTED)
	@RequirePermissions("messaging.manage")
	async submitTollFreeVerification(@Session() session: AppSession, @Body() body: unknown) {
		return await this.registration.submitTollFreeVerification(
			session,
			parseDto(submitTollFreeVerificationDto, body ?? {}),
		);
	}
}
