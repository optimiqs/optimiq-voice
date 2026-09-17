import { ConflictException, HttpStatus } from "@nestjs/common";

/**
 * The refusals that belong to the dispatchable-location gate.
 *
 * Nest exceptions rather than `Schema.TaggedErrorClass` failures, for the same structural reason
 * the carrier slice's are (`carrier/carrier.errors.ts`): these fire *above* the Effect seam — in a
 * service method that has already decided not to call the repository — so wrapping them as typed
 * repository failures would invent a boundary they never cross.
 *
 * They keep the PBX body contract exactly, because `apps/web` switches on `code`.
 */

/**
 * An unvalidated address was about to be attached to something that can originate 911.
 *
 * ## Why this is a refusal and not a warning
 *
 * `emergency-schema.ts` states the rule the whole table exists for: *"a number may only be used for
 * emergency origination once its address has been validated by the upstream provider."* Until this
 * exception existed, that sentence described an intention — `phone_number.emergency_address_id`
 * accepted any address in the tenant, and the only thing standing between an unverified string and
 * a live 911 route was an admin noticing a badge in the UI.
 *
 * A warning would be the wrong shape here because of *when* the cost lands. Every other
 * misconfiguration in this product announces itself on the next call: a wrong destination rings the
 * wrong phone, a bad trunk fails to register. A bad dispatchable location is silent for as long as
 * nobody dials 911, and then it is not a support ticket. So the write is refused at the seam where
 * it is still cheap to fix, and the message says the one thing that fixes it — validate the
 * address first.
 *
 * 409 rather than 422: the request body is well-formed and the address exists. What is wrong is the
 * *state* of the row it points at, which is the conflict a 409 describes, and which the caller
 * resolves by changing that state rather than by sending different values.
 */
export class EmergencyAddressNotValidatedException extends ConflictException {
	constructor(addressId: string, subject = "this record") {
		super({
			statusCode: HttpStatus.CONFLICT,
			code: "EMERGENCY_ADDRESS_NOT_VALIDATED",
			message:
				`That emergency address has not been validated by the carrier, so it cannot be ` +
				`attached to ${subject}. Validate it first (POST /api/v1/emergency-addresses/${addressId}/validate); ` +
				"a 911 call carrying an unvalidated location may not reach the right PSAP.",
			field: "emergencyAddressId",
			addressId,
		});
	}
}
