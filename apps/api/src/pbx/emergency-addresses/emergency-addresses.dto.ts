import { z } from "zod/v4";
import { displayName, patchOf } from "../shared/dto";

/**
 * A dispatchable location.
 *
 * ## The validation is deliberately shallow, and that is not laziness
 *
 * Every field below is a length bound and a non-empty check. There is no postal-code format, no
 * state-abbreviation list, no street-suffix normalisation — and there must not be, because this
 * address is going to be handed to a **carrier's E911 provisioning API**, which will validate it
 * against the authoritative database (the MSAG, in North America) and answer either "this is a
 * dispatchable location" or "it is not, here is why". That answer is what `validated` records.
 *
 * A second, weaker validator here would produce the worst possible failure: an address this API
 * refused because its own rules disagreed with the carrier's, for a building that exists and that
 * somebody may one day dial 911 from. So the rule is: **accept what a person can plausibly have
 * typed, and let the authority say whether it is real.** The only things refused are the ones that
 * are wrong in every jurisdiction — an empty street, an empty locality, a country code that is not
 * two letters.
 *
 * ## `country` is ISO 3166-1 alpha-2, upper-cased on the way in
 *
 * Stored upper-case so `us` and `US` are one address rather than two, and because every carrier API
 * that takes a country code takes it upper-case. The transform is here rather than in the service
 * because it is a property of the FIELD.
 *
 * ## `validated` and its three companions are absent, and always will be
 *
 * `validated`, `validatedAt`, `validationProvider` and `validationReference` are facts a PROVIDER
 * asserted, not values an admin may set. Accepting `validated: true` from a request body would let
 * anyone with `numbers.emergency` mark an unverified address as verified — which, for a field whose
 * entire purpose is regulatory assurance, is not a validation bug but a compliance one. They are
 * written by a future carrier-provisioning path and by nothing else.
 */
const requiredLine = z.string().trim().min(1).max(128);

export const createEmergencyAddressDto = z.strictObject({
	/** What an admin calls this place: "Head office", "Warehouse — loading bay". Unique per tenant. */
	label: displayName,
	streetLine1: requiredLine,
	streetLine2: z.string().trim().max(128).nullish(),
	/**
	 * Floor, suite, room — the detail that turns an address into a DISPATCHABLE location.
	 *
	 * Nullable, because a single-occupancy building genuinely has none, and required by nothing here
	 * for the same reason the rest of this schema is shallow. The admin UI marks it strongly
	 * recommended and says why: a responder given a twelve-floor office block and no floor number is
	 * the failure RAY BAUM'S was written about.
	 */
	locationDetail: z.string().trim().max(128).nullish(),
	locality: requiredLine,
	/** State, province or region. Named for the ISO term because "state" is not universal. */
	administrativeArea: requiredLine,
	postalCode: z.string().trim().min(1).max(32),
	country: z
		.string()
		.trim()
		.length(2, "must be an ISO 3166-1 alpha-2 country code, e.g. US")
		.regex(/^[A-Za-z]{2}$/u, "must be two letters")
		.transform((value) => value.toUpperCase())
		.optional(),
});

export const updateEmergencyAddressDto = patchOf(createEmergencyAddressDto);
