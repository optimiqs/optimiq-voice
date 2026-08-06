import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { createNumberOrderDto, provisionTrunkDto, searchAvailableNumbersDto } from "./carrier.dto";
import { CarrierService } from "./carrier.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/carrier/*` — buying and configuring numbers at the managed carrier.
 *
 * ## Why `numbers.order` and not `numbers.write`
 *
 * Search and order are one two-step protocol — Telnyx refuses to sell a number that was not
 * returned by a prior search on the same account — so they carry the same grant. That grant is
 * `numbers.order` rather than `numbers.write` because the two differ in the way that matters: a
 * write changes how a number the organization already pays for behaves, an order **adds a
 * recurring charge**. A manager who may re-point a DID at a different IVR has not thereby been
 * given a budget.
 *
 * Release is the mirror image and deliberately does NOT get its own grant. It rides
 * `numbers.delete`, because a role that could delete the row but not release the number upstream
 * would leave DIDs orphaned at the carrier, billed forever, invisible to the tenant who caused it.
 * Splitting them would create that state; keeping them together makes it unreachable.
 */
@Controller("api/v1/carrier")
export class CarrierController {
	constructor(@Inject(CarrierService) private readonly carrier: CarrierService) {}

	/**
	 * Whether a carrier is configured at all.
	 *
	 * Gated on `numbers.read` rather than left open: it discloses which carrier the platform uses
	 * and whether webhooks are wired, which is operational detail, not a public capability probe.
	 * It answers 200 either way — the whole point is that the UI can render a "connect a carrier"
	 * callout instead of a failed request.
	 */
	@Get("status")
	@RequirePermissions("numbers.read")
	status(@Session() _session: AppSession) {
		return this.carrier.status();
	}

	@Get("available-numbers")
	@RequirePermissions("numbers.order")
	async search(@Session() session: AppSession, @Query() query: unknown) {
		return await this.carrier.searchAvailableNumbers(
			session,
			parseDto(searchAvailableNumbersDto, query ?? {}),
		);
	}

	@Post("number-orders")
	@RequirePermissions("numbers.order")
	async order(@Session() session: AppSession, @Body() body: unknown) {
		return await this.carrier.orderNumber(session, parseDto(createNumberOrderDto, body));
	}

	/**
	 * `DELETE /api/v1/carrier/numbers/:id` — delete the row AND release upstream.
	 *
	 * A separate route from `DELETE /api/v1/phone-numbers/:id` rather than a change to it, because
	 * the two are different operations with different consequences and a caller must be able to
	 * choose. Removing a DID from the organization's inventory without giving it back to the
	 * carrier is a real and occasionally correct thing to want — a number being migrated between
	 * tenants, say — and folding release into the existing delete would make it unexpressible while
	 * also changing the behaviour of an endpoint that already shipped.
	 */
	@Delete("numbers/:id")
	@RequirePermissions("numbers.delete")
	async release(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.carrier.releaseNumber(session, id);
	}
}

/**
 * `/api/v1/trunks/:id/provision-telnyx`.
 *
 * Mounted on the trunks path rather than under `/carrier` because it is an operation *on a trunk*
 * — the resource it mutates is the trunk row, the permission it needs is the trunk's, and a client
 * that has a trunk id should not have to know which carrier the platform uses to find the endpoint
 * that configures it.
 *
 * `trunks.write` and no new grant: "change how this organization reaches the PSTN" is already
 * exactly what that permission means, and the spend this creates is bounded by the outbound voice
 * profile's daily cap rather than being open-ended like a number order.
 */
@Controller("api/v1/trunks")
export class CarrierTrunkController {
	constructor(@Inject(CarrierService) private readonly carrier: CarrierService) {}

	@Post(":id/provision-telnyx")
	@RequirePermissions("trunks.write")
	async provision(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.carrier.provisionTrunk(session, id, parseDto(provisionTrunkDto, body ?? {}));
	}
}
