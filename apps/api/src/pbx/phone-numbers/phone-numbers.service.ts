import { Inject, Injectable } from "@nestjs/common";
import { EmergencyAddressesService } from "../emergency-addresses/emergency-addresses.service";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { PHONE_NUMBER_RESOURCE } from "./phone-numbers.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * DIDs, plus the one gate that is not generic CRUD: an emergency address may not be attached to a
 * number until a carrier has confirmed it is a real dispatchable location.
 *
 * The check sits HERE, in front of the write, rather than as a database constraint, because the
 * fact it depends on lives on another row and changes over time — an address is validated by an
 * API round trip, not by its own columns. `assertAssignable` is a no-op for a null or cleared
 * value, so detaching an address stays possible whatever its state; it is only ATTACHING an
 * unvalidated one that is refused, with `EMERGENCY_ADDRESS_NOT_VALIDATED`.
 *
 * An unvalidated dispatchable location is worse than none: it reads as compliant on the screen and
 * sends an ambulance to a door that does not exist. RAY BAUM's Act asks for a location that is
 * actually dispatchable, and the only party that can say whether an address is dispatchable is the
 * one that would dispatch to it.
 */
@Injectable()
export class PhoneNumbersService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(EmergencyAddressesService)
		private readonly emergencyAddresses: EmergencyAddressesService,
	) {
		super(runtime, PHONE_NUMBER_RESOURCE);
	}

	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): ReturnType<PbxResourceService["create"]> {
		await this.assertEmergencyAddressAssignable(session, values);
		return await super.create(session, values);
	}

	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): ReturnType<PbxResourceService["update"]> {
		await this.assertEmergencyAddressAssignable(session, values);
		return await super.update(session, id, values);
	}

	/**
	 * Only when the write actually names the column.
	 *
	 * A PATCH that does not mention `emergencyAddressId` leaves whatever is attached in place, and
	 * re-checking it would make an unrelated edit — renaming the DID's label — fail because of an
	 * address somebody attached before this gate existed. Grandfathered rows are corrected by
	 * validating the address, which is a one-call fix, not by making every other field unwritable.
	 */
	private async assertEmergencyAddressAssignable(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<void> {
		if (!Object.hasOwn(values, "emergencyAddressId")) {
			return;
		}
		const addressId = values.emergencyAddressId;
		await this.emergencyAddresses.assertAssignable(
			session,
			typeof addressId === "string" ? addressId : null,
			typeof values.e164 === "string" ? `phone number ${values.e164}` : "this phone number",
		);
	}
}
