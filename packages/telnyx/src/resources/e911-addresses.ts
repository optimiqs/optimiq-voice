import { z } from "zod";
import { TelnyxError } from "../errors";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/addresses` — the carrier's address book, which is what E911 dispatchable-location
 * validation actually runs against.
 *
 * ## Why an address has to be a carrier object and not a local row
 *
 * RAY BAUM'S Act (§9.8) requires a 911 call to convey a *dispatchable location*, and the only
 * authority that can say whether a typed address IS one is the MSAG — the master street address
 * guide the PSAPs themselves are keyed off. Nothing in this repository can consult it. Telnyx can,
 * and does so in two different ways that this module deliberately keeps separate:
 *
 * - **{@link E911AddressesResource.validate}** (`POST /v2/addresses/actions/validate`) asks the
 *   question without creating anything. It is free, idempotent and side-effect-free, and it can
 *   answer `suggested` — "not what you typed, but this nearby thing is real" — which is the answer
 *   an admin can act on.
 * - **{@link E911AddressesResource.create}** (`POST /v2/addresses`) persists the address at the
 *   carrier and hands back an id. That id is the thing worth storing: it is what an E911
 *   provisioning call later attaches to a number, and it is what makes "validated" a claim we can
 *   point at somebody else's record for rather than an assertion about our own database.
 *
 * The API layer wants both — the answer, and a reference to keep — so `create` takes
 * `validateAddress`, Telnyx's own flag for "refuse this write unless the address validates". A
 * `create` that succeeded is therefore itself a validation result, and the id it returns is the
 * `validation_reference` the `emergency_address` row records.
 *
 * ## Nothing here is retried into a different meaning
 *
 * Creating an address is not billable and Telnyx de-duplicates identical addresses, so the default
 * retry policy is left alone — unlike `number-orders.ts` and `faxes.ts`, where a second execution
 * is a second purchase. `DELETE` is the one call whose repeat is visible, and it is idempotent in
 * the direction that matters (the second one 404s).
 *
 * Field names are pinned in `reference/telnyx-api.md` §Addresses.
 */

/**
 * The three answers `POST /v2/addresses/actions/validate` can give.
 *
 * `suggested` is the interesting one and the reason this is not a boolean: the address as typed is
 * not in the MSAG, but the carrier recognised what was meant and is offering the canonical form.
 * Collapsing it into "invalid" would throw away the correction and leave an admin retyping an
 * address that was nearly right.
 */
export const TELNYX_ADDRESS_VALIDATION_RESULTS = ["valid", "invalid", "suggested"] as const;
export type TelnyxAddressValidationResult = (typeof TELNYX_ADDRESS_VALIDATION_RESULTS)[number];

/**
 * A carrier address record.
 *
 * Required iff we persist it or branch on it (the `schemas.ts` policy): `id` is what the
 * `emergency_address` row stores as its `validation_reference`, and nothing else here is written
 * back. `address_book` and the name fields are typed for convenience only.
 */
export const telnyxAddressSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	customer_reference: z.string().nullish(),
	business_name: z.string().nullish(),
	first_name: z.string().nullish(),
	last_name: z.string().nullish(),
	phone_number: z.string().nullish(),
	street_address: z.string().nullish(),
	extended_address: z.string().nullish(),
	locality: z.string().nullish(),
	administrative_area: z.string().nullish(),
	postal_code: z.string().nullish(),
	country_code: z.string().nullish(),
	address_book: z.boolean().optional(),
	validate_address: z.boolean().optional(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxAddress = z.infer<typeof telnyxAddressSchema>;

/**
 * The validation answer. `result` is required — it is the entire point of the call, and a response
 * without it is one this client cannot act on, so it must fail loudly at the seam rather than be
 * read as "not valid" and quietly deny a building its 911 service.
 *
 * `suggested` carries the canonical address when `result` is `suggested`; `errors` carries the
 * carrier's own reason strings when it is `invalid`, and those strings are what the API layer
 * shows the admin. They are the carrier's words on purpose — a paraphrase would be this
 * platform's guess about somebody else's database.
 */
export const telnyxAddressValidationSchema = z.looseObject({
	record_type: z.string().optional(),
	result: z.string(),
	suggested: z
		.looseObject({
			street_address: z.string().nullish(),
			extended_address: z.string().nullish(),
			locality: z.string().nullish(),
			administrative_area: z.string().nullish(),
			postal_code: z.string().nullish(),
			country_code: z.string().nullish(),
		})
		.nullish(),
	errors: z
		.array(
			z.looseObject({
				code: z.string().nullish(),
				message: z.string().nullish(),
			}),
		)
		.nullish(),
});

export type TelnyxAddressValidation = z.infer<typeof telnyxAddressValidationSchema>;

/** `true` for the one answer that means "this is a dispatchable location, as typed". */
export function isTelnyxAddressValid(result: string): boolean {
	return result === "valid";
}

/** The postal fields both endpoints take. Shared so a validate and a create cannot drift. */
export interface E911AddressFields {
	readonly streetAddress: string;
	/** Floor / suite / room — the detail that makes an address *dispatchable*. */
	readonly extendedAddress?: string | null;
	readonly locality: string;
	readonly administrativeArea: string;
	readonly postalCode: string;
	/** ISO 3166-1 alpha-2, upper-case. Checked before the round trip by {@link assertAddressCountry}. */
	readonly countryCode: string;
}

export interface CreateE911AddressInput extends E911AddressFields {
	readonly businessName?: string;
	readonly firstName?: string;
	readonly lastName?: string;
	readonly phoneNumber?: string;
	readonly customerReference?: string;
	/**
	 * Telnyx's own "refuse the write unless this address validates" flag. Defaults to `true` here,
	 * which inverts the carrier's default on purpose: an address created without it is a stored
	 * string nobody checked, and this package exists in this repository for exactly one reason —
	 * to produce a validation the `validated` column can honestly cite.
	 */
	readonly validateAddress?: boolean;
}

/** Raised for an address whose country code is unusable, before any network call. */
export class TelnyxAddressFormatError extends TelnyxError {
	readonly field: string;
	constructor(field: string, detail: string) {
		super(`Telnyx address invalid (${field}): ${detail}`);
		this.field = field;
	}
}

/**
 * Refuses a country code the addresses API cannot interpret, before a request is built.
 *
 * Client-side because the failure is expensive and mute in both directions: Telnyx answers a
 * lower-case or three-letter code with a generic 422 that names no field, and an admin is left
 * looking at "the carrier rejected your address" for a building that is perfectly real. A local
 * throw puts the message next to the input.
 */
export function assertAddressCountry(countryCode: string): void {
	if (!/^[A-Z]{2}$/u.test(countryCode)) {
		throw new TelnyxAddressFormatError(
			"country_code",
			`must be an upper-case ISO 3166-1 alpha-2 code; got "${countryCode}"`,
		);
	}
}

const addressResponse = dataEnvelope(telnyxAddressSchema);
const addressListResponse = listEnvelope(telnyxAddressSchema);
const validationResponse = dataEnvelope(telnyxAddressValidationSchema);

export interface ListE911AddressesQuery {
	readonly customerReference?: string;
	readonly pageSize?: number;
	readonly pageNumber?: number;
}

function addressBody(input: E911AddressFields): Record<string, unknown> {
	return {
		street_address: input.streetAddress,
		...(input.extendedAddress === undefined || input.extendedAddress === null
			? {}
			: { extended_address: input.extendedAddress }),
		locality: input.locality,
		administrative_area: input.administrativeArea,
		postal_code: input.postalCode,
		country_code: input.countryCode,
	};
}

export interface E911AddressesResource {
	/**
	 * Asks whether an address is a dispatchable location, creating nothing. The free, repeatable
	 * half — use it to answer an admin, and `create` to keep a reference.
	 */
	readonly validate: (input: E911AddressFields) => Promise<TelnyxAddressValidation>;
	/**
	 * Persists an address at the carrier and returns it with the id worth storing. Validates by
	 * default, so a resolved promise is itself the evidence `validated` records.
	 */
	readonly create: (input: CreateE911AddressInput) => Promise<TelnyxAddress>;
	readonly get: (addressId: string) => Promise<TelnyxAddress>;
	readonly list: (query?: ListE911AddressesQuery) => Promise<readonly TelnyxAddress[]>;
	/** Removes an address from the carrier's book. Returns the deleted record, like `phone_numbers`. */
	readonly remove: (addressId: string) => Promise<TelnyxAddress>;
}

export function makeE911Addresses(transport: TelnyxTransport): E911AddressesResource {
	return {
		validate: async (input) => {
			assertAddressCountry(input.countryCode);
			const response = await transport.request({
				method: "POST",
				path: "/addresses/actions/validate",
				body: addressBody(input),
				schema: validationResponse,
			});
			return response.data;
		},

		create: async (input) => {
			assertAddressCountry(input.countryCode);
			const response = await transport.request({
				method: "POST",
				path: "/addresses",
				body: {
					...addressBody(input),
					validate_address: input.validateAddress ?? true,
					...(input.businessName === undefined ? {} : { business_name: input.businessName }),
					...(input.firstName === undefined ? {} : { first_name: input.firstName }),
					...(input.lastName === undefined ? {} : { last_name: input.lastName }),
					...(input.phoneNumber === undefined ? {} : { phone_number: input.phoneNumber }),
					...(input.customerReference === undefined
						? {}
						: { customer_reference: input.customerReference }),
				},
				schema: addressResponse,
			});
			return response.data;
		},

		get: async (addressId) => {
			const response = await transport.request({
				method: "GET",
				path: `/addresses/${encodeURIComponent(addressId)}`,
				schema: addressResponse,
			});
			return response.data;
		},

		list: async (query = {}) => {
			const response = await transport.request({
				method: "GET",
				path: "/addresses",
				query: {
					"filter[customer_reference]": query.customerReference,
					"page[size]": query.pageSize,
					"page[number]": query.pageNumber,
				},
				schema: addressListResponse,
			});
			return response.data;
		},

		remove: async (addressId) => {
			const response = await transport.request({
				method: "DELETE",
				path: `/addresses/${encodeURIComponent(addressId)}`,
				schema: addressResponse,
			});
			return response.data;
		},
	};
}
