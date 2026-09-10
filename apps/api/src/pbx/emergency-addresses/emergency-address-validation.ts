import { isTelnyxAddressValid, TelnyxApiError } from "@optimiq-voice/telnyx";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

/**
 * The carrier half of dispatchable-location validation, with no database and no session in sight.
 *
 * Kept as free functions rather than a Nest provider on purpose. A provider would have to be
 * registered in `pbx.module.ts` and injected into the one service that uses it, which buys nothing:
 * there is no state to hold, no lifecycle to manage, and the only dependency is a `TelnyxClient`
 * the service already has. What it *would* buy is a second place where "what does validation mean"
 * is decided, and this file exists so that question has exactly one answer.
 *
 * ## The provider name is a constant, not a parameter
 *
 * `emergency_address.validation_provider` records who asserted the location. Today that is always
 * Telnyx, and writing the string at every call site is how a second carrier silently becomes
 * "telnyx" in half the rows. When a second provider arrives, this constant becomes a lookup and the
 * compiler names every place that has to change.
 */
export const EMERGENCY_VALIDATION_PROVIDER = "telnyx";

/** The postal fields a validation reads off an `emergency_address` row. */
export interface EmergencyAddressFields {
	readonly streetLine1: string;
	readonly streetLine2?: string | null;
	readonly locationDetail?: string | null;
	readonly locality: string;
	readonly administrativeArea: string;
	readonly postalCode: string;
	readonly country?: string | null;
}

/**
 * What the carrier said, in this platform's vocabulary.
 *
 * `reason` and `suggestion` are the carrier's own words, passed through rather than paraphrased: a
 * rewrite would be this platform guessing about somebody else's address database, and the admin
 * who has to fix the address is better served by what the authority actually said.
 */
export interface CarrierValidationOutcome {
	readonly validated: boolean;
	/** The carrier's address id, and the value stored as `validation_reference`. Null when refused. */
	readonly reference: string | null;
	/** `valid` | `invalid` | `suggested`, or `error` when the carrier could not be asked. */
	readonly result: string;
	/** Why it was refused, verbatim. Null when it was not. */
	readonly reason: string | null;
	/** The canonical address the carrier offered instead, when it offered one. */
	readonly suggestion: Record<string, unknown> | null;
}

/**
 * The `extended_address` a carrier sees.
 *
 * `locationDetail` ("Floor 3, Room 314") is preferred over `streetLine2` because it is the field
 * that makes this a *dispatchable* location under RAY BAUM'S §9.8 — if only one of the two can be
 * carried, the responder needs the floor more than the building's second address line.
 */
function extendedAddress(address: EmergencyAddressFields): string | undefined {
	const detail = address.locationDetail ?? address.streetLine2;
	return detail === null || detail === undefined || detail.length === 0 ? undefined : detail;
}

/**
 * Asks the carrier whether an address is a dispatchable location, and — when it is — registers it
 * so there is a carrier-side id to cite.
 *
 * The two calls are deliberate and in this order. `validate` is free, creates nothing, and is the
 * only one that can answer `suggested`, which is the answer an admin can act on; `create` is what
 * produces the `validation_reference` an E911 provisioning call will later need. Doing only the
 * create would collapse "not a real address" and "nearly right, here is the real one" into one
 * opaque 422.
 *
 * A carrier that refuses the create *after* answering `valid` is reported as unvalidated with the
 * carrier's own error text. That is not a contradiction to paper over: the address book is the
 * record E911 provisioning reads, so an address that is not in it is not one this platform may
 * claim to have validated.
 */
export async function validateAddressWithCarrier(
	telnyx: TelnyxClient,
	address: EmergencyAddressFields,
	customerReference?: string,
): Promise<CarrierValidationOutcome> {
	const fields = {
		streetAddress: address.streetLine1,
		extendedAddress: extendedAddress(address),
		locality: address.locality,
		administrativeArea: address.administrativeArea,
		postalCode: address.postalCode,
		countryCode: (address.country ?? "US").toUpperCase(),
	};

	const answer = await telnyx.e911Addresses.validate(fields);
	if (!isTelnyxAddressValid(answer.result)) {
		return {
			validated: false,
			reference: null,
			result: answer.result,
			reason: carrierReason(answer.errors, answer.result),
			suggestion: (answer.suggested as Record<string, unknown> | null | undefined) ?? null,
		};
	}

	try {
		const created = await telnyx.e911Addresses.create({
			...fields,
			validateAddress: true,
			...(customerReference === undefined ? {} : { customerReference }),
		});
		return {
			validated: true,
			reference: created.id,
			result: "valid",
			reason: null,
			suggestion: null,
		};
	} catch (error) {
		if (error instanceof TelnyxApiError) {
			return {
				validated: false,
				reference: null,
				result: "invalid",
				reason: error.errors.map((entry) => entry.detail ?? entry.title).join("; "),
				suggestion: null,
			};
		}
		throw error;
	}
}

function carrierReason(
	errors: readonly { code?: string | null; message?: string | null }[] | null | undefined,
	result: string,
): string {
	const messages = (errors ?? [])
		.map((entry) => entry.message)
		.filter((message): message is string => typeof message === "string" && message.length > 0);
	if (messages.length > 0) {
		return messages.join("; ");
	}
	return result === "suggested"
		? "The carrier did not recognise this address but offered a corrected form."
		: "The carrier does not recognise this address as a dispatchable location.";
}
