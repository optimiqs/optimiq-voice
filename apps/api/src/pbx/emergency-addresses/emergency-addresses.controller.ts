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
import { createEmergencyAddressDto, updateEmergencyAddressDto } from "./emergency-addresses.dto";
import { EmergencyAddressesService } from "./emergency-addresses.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/emergency-addresses` — dispatchable locations for E911.
 *
 * ## The permissions
 *
 * | Route                     | Permission          |
 * | ------------------------- | ------------------- |
 * | `GET`                     | `numbers.read`      |
 * | `POST` / `PATCH` / `DELETE` | `numbers.emergency` |
 *
 * `numbers.emergency` already exists in the registry and its catalog entry says exactly this:
 * *"Manage emergency routing — Set the dispatchable location and notification policy (Kari's Law /
 * RAY BAUM'S)."* It was minted for this feature before the feature existed, and this is the first
 * route to use it.
 *
 * Reads are `numbers.read` rather than `numbers.emergency` on purpose: the number list has to be
 * able to show which DID has which location, and a role that can see the numbers but not the
 * addresses they point at would render a column of ids. Writing is the decision that carries
 * regulatory weight, and writing is what the narrower permission guards.
 *
 * ## `PATCH` is a real edit, and it now re-asks the carrier
 *
 * An address that a carrier has validated and that a DID is using can be edited in place. It used
 * to keep `validated: true` through that edit — this API could not revalidate, and clearing the flag
 * would have turned every typo fix into "this number can no longer originate 911" — which left a
 * validated row whose address the carrier had never seen. Now `create` and `PATCH` both run the
 * carrier validation themselves when a carrier is configured, so the flag follows the address
 * rather than lagging behind it. See `emergency-addresses.service.ts`.
 */
@Controller("api/v1/emergency-addresses")
export class EmergencyAddressesController {
	constructor(
		@Inject(EmergencyAddressesService) private readonly addresses: EmergencyAddressesService,
	) {}

	@Get()
	@RequirePermissions("numbers.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.addresses.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("numbers.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.addresses.get(session, id);
	}

	@Post()
	@RequirePermissions("numbers.emergency")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.addresses.create(session, parseDto(createEmergencyAddressDto, body));
	}

	@Patch(":id")
	@RequirePermissions("numbers.emergency")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.addresses.update(session, id, parseDto(updateEmergencyAddressDto, body));
	}

	/**
	 * Asks the carrier whether this address is a dispatchable location, and records the answer.
	 *
	 * `numbers.emergency` rather than `numbers.read`, even though it reads like a query: it WRITES
	 * `validated` and its three companions, and those four are the regulatory claim this whole table
	 * exists to make.
	 *
	 * Answers 200 whether the carrier accepted or refused — the refusal, with the carrier's own
	 * reason and any corrected address it offered, is the useful answer — and
	 * `503 CARRIER_NOT_CONFIGURED` on a deployment with no `TELNYX_API_KEY`.
	 */
	@Post(":id/validate")
	@RequirePermissions("numbers.emergency")
	async validate(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.addresses.validateWithCarrier(session, id);
	}

	/**
	 * Deletes an address.
	 *
	 * Refused with a `409` naming every DID that still points at it, rather than allowed with the
	 * database's `on delete set null`. Silently stripping a dispatchable location from a live number
	 * is the single worst change this table can undergo, and it would be invisible until somebody
	 * dialled 911.
	 */
	@Delete(":id")
	@RequirePermissions("numbers.emergency")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.addresses.remove(session, id);
	}
}
