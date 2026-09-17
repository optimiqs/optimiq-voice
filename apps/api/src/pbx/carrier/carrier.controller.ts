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
import {
	createNumberOrderDto,
	createPortingOrderDto,
	listPortingOrdersDto,
	provisionTrunkDto,
	searchAvailableNumbersDto,
	updateCnamListingDto,
} from "./carrier.dto";
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
 *
 * ## Porting and CNAM land on the same three grants, and no fourth one
 *
 * **Filing a port is `numbers.order`.** It is not a write to a number the organization has — it is
 * a commitment to take one over and pay for it every month afterwards, which is the exact thing
 * `numbers.order` was separated out to gate. Reading ports is `numbers.read` for the same reason
 * the carrier status probe is: it is inventory, not capability.
 *
 * **Changing a CNAM listing is `numbers.write`**, because it changes how a DID the organization
 * already owns behaves and adds nothing to the bill — the same class of change as re-pointing the
 * number at a different IVR. Giving it its own grant would mean every role that manages numbers
 * needs a permission whose only distinct meaning is "and also the caller-ID name", which is how a
 * permission registry stops being readable.
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
	 * `POST /api/v1/carrier/porting-orders` — file a port-in.
	 *
	 * Answers with an ARRAY of orders, because the carrier splits a request across losing carriers
	 * and this endpoint refuses to pretend otherwise. See `CarrierService.createPortingOrder` for
	 * why it writes no `phone_number` row.
	 */
	@Post("porting-orders")
	@RequirePermissions("numbers.order")
	async createPortingOrder(@Session() session: AppSession, @Body() body: unknown) {
		return await this.carrier.createPortingOrder(session, parseDto(createPortingOrderDto, body));
	}

	@Get("porting-orders")
	@RequirePermissions("numbers.read")
	async listPortingOrders(@Session() session: AppSession, @Query() query: unknown) {
		return await this.carrier.listPortingOrders(
			session,
			parseDto(listPortingOrdersDto, query ?? {}),
		);
	}

	/**
	 * One port's status.
	 *
	 * `ParseUUIDPipe` even though the id is the carrier's rather than ours: Telnyx porting-order ids
	 * are UUIDs, and validating that here is what keeps an arbitrary string out of a path this
	 * service interpolates into a carrier URL.
	 */
	@Get("porting-orders/:id")
	@RequirePermissions("numbers.read")
	async getPortingOrder(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.carrier.getPortingOrder(session, id);
	}

	/**
	 * `GET|PATCH /api/v1/carrier/numbers/:id/cnam` — the caller-ID name a called party sees.
	 *
	 * `:id` is the LOCAL `phone_number` id, never the carrier's. That is what makes the pair
	 * tenant-safe: the lookup that resolves it is organization-scoped, so another tenant's number
	 * is a 404 before a carrier request exists. Accepting a Telnyx id would have made this a
	 * read-anyone's-CNAM oracle over a namespace shared with every other Telnyx customer.
	 */
	@Get("numbers/:id/cnam")
	@RequirePermissions("numbers.read")
	async getCnam(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.carrier.getCnamListing(session, id);
	}

	@Patch("numbers/:id/cnam")
	@RequirePermissions("numbers.write")
	async updateCnam(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.carrier.updateCnamListing(session, id, parseDto(updateCnamListingDto, body));
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
