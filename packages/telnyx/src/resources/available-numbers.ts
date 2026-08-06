import { z } from "zod";
import { listEnvelope } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `GET /v2/available_phone_numbers` — the search that must precede every order.
 *
 * "Must" is literal: Telnyx rejects an order for a number that was not returned by a search on the
 * same account with error `85000`. So this is not a convenience listing that a UI could skip by
 * letting an admin type an E.164 — it is step one of a two-step protocol, and the API layer's
 * order endpoint is documented to say so.
 *
 * Pinned to `reference/telnyx-api.md` §Number search.
 */

/** Number classes Telnyx will sell. `local` is the default a PBX wants. */
export const TELNYX_PHONE_NUMBER_TYPES = [
	"local",
	"toll_free",
	"mobile",
	"national",
	"shared_cost",
] as const;
export type TelnyxPhoneNumberType = (typeof TELNYX_PHONE_NUMBER_TYPES)[number];

export const TELNYX_NUMBER_FEATURES = [
	"sms",
	"mms",
	"voice",
	"fax",
	"emergency",
	"hd_voice",
	"international_sms",
	"local_calling",
] as const;
export type TelnyxNumberFeature = (typeof TELNYX_NUMBER_FEATURES)[number];

/**
 * `features` is an array of OBJECTS (`[{ "name": "voice" }]`), not of strings — one of the shapes
 * most likely to be mis-remembered, so it is spelled out rather than inferred.
 */
const featureSchema = z.looseObject({ name: z.string() });

const regionSchema = z.looseObject({
	region_type: z.string().optional(),
	region_name: z.string().optional(),
});

/** Costs come back as decimal STRINGS. Never coerced to a number: money is not a float. */
const costSchema = z.looseObject({
	upfront_cost: z.string().optional(),
	monthly_cost: z.string().optional(),
	currency: z.string().optional(),
});

export const availablePhoneNumberSchema = z.looseObject({
	phone_number: z.string(),
	record_type: z.string().optional(),
	vanity_format: z.string().nullish(),
	best_effort: z.boolean().optional(),
	quickship: z.boolean().optional(),
	reservable: z.boolean().optional(),
	region_information: z.array(regionSchema).optional(),
	cost_information: costSchema.optional(),
	features: z.array(featureSchema).optional(),
});

export type TelnyxAvailablePhoneNumber = z.infer<typeof availablePhoneNumberSchema>;

const availableNumbersResponse = listEnvelope(availablePhoneNumberSchema).extend({
	/** Telnyx sends `meta` AND `metadata` with identical content. Both optional; neither trusted. */
	metadata: z
		.looseObject({
			total_results: z.number().optional(),
			best_effort_results: z.number().optional(),
		})
		.optional(),
});

export interface AvailableNumberSearch {
	readonly countryCode?: string;
	/** Area code / NDC. */
	readonly nationalDestinationCode?: string;
	readonly contains?: string;
	readonly startsWith?: string;
	readonly endsWith?: string;
	readonly locality?: string;
	readonly administrativeArea?: string;
	readonly phoneNumberType?: TelnyxPhoneNumberType;
	readonly features?: readonly TelnyxNumberFeature[];
	readonly limit?: number;
	readonly bestEffort?: boolean;
	readonly quickship?: boolean;
	readonly reservable?: boolean;
	readonly excludeHeldNumbers?: boolean;
}

/**
 * Builds the bracketed filter keys by hand.
 *
 * A generic nested-object stringifier would have to invent a bracket convention and would then be
 * the thing to debug when Telnyx ignores a filter it does not recognize (it ignores unknown
 * filters silently, returning an unfiltered page that looks like a working search). Writing the
 * literal keys makes every one of them greppable against the reference document.
 *
 * `filter[features]` repeats for each value, which `URLSearchParams.set` cannot express, so the
 * caller-facing array is joined the way Telnyx's deepObject/explode serialization expects.
 */
export function availableNumbersQuery(
	search: AvailableNumberSearch,
): Record<string, string | number | boolean | undefined> {
	const query: Record<string, string | number | boolean | undefined> = {
		"filter[country_code]": search.countryCode,
		"filter[national_destination_code]": search.nationalDestinationCode,
		"filter[phone_number][contains]": search.contains,
		"filter[phone_number][starts_with]": search.startsWith,
		"filter[phone_number][ends_with]": search.endsWith,
		"filter[locality]": search.locality,
		"filter[administrative_area]": search.administrativeArea,
		"filter[phone_number_type]": search.phoneNumberType,
		"filter[limit]": search.limit,
		"filter[best_effort]": search.bestEffort,
		"filter[quickship]": search.quickship,
		"filter[reservable]": search.reservable,
		"filter[exclude_held_numbers]": search.excludeHeldNumbers,
	};
	if (search.features !== undefined && search.features.length > 0) {
		for (const [index, feature] of search.features.entries()) {
			query[`filter[features][${index}]`] = feature;
		}
	}
	return query;
}

export interface AvailableNumbersResource {
	readonly search: (search: AvailableNumberSearch) => Promise<{
		readonly data: readonly TelnyxAvailablePhoneNumber[];
		readonly totalResults?: number;
	}>;
}

export function makeAvailableNumbers(transport: TelnyxTransport): AvailableNumbersResource {
	return {
		search: async (search) => {
			const response = await transport.request({
				method: "GET",
				path: "/available_phone_numbers",
				query: availableNumbersQuery(search),
				schema: availableNumbersResponse,
			});
			const totalResults = response.meta?.total_results ?? response.metadata?.total_results;
			return {
				data: response.data,
				...(totalResults === undefined ? {} : { totalResults }),
			};
		},
	};
}
