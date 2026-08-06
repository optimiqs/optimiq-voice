import { z } from "zod/v4";
import { TELNYX_NUMBER_FEATURES, TELNYX_PHONE_NUMBER_TYPES } from "@optimiq-voice/telnyx";
import { destinationShape, e164 } from "../shared/dto";

/**
 * Carrier DTOs.
 *
 * `z.strictObject` throughout, per `shared/dto.ts`: an unknown key is a client that thinks it is
 * setting something, and silently dropping it is how "I asked for a toll-free number and got a
 * local one" happens.
 */

/**
 * `GET /api/v1/carrier/available-numbers`.
 *
 * Query strings arrive as strings, so the numeric and boolean fields are coerced rather than
 * declared as their target types — `z.coerce` here is the difference between a working `?limit=5`
 * and a 400 telling the user that "5" is not a number.
 */
export const searchAvailableNumbersDto = z.strictObject({
	country: z
		.string()
		.length(2)
		.regex(/^[A-Za-z]{2}$/u, "must be an ISO 3166 alpha-2 country code")
		.transform((value) => value.toUpperCase())
		.default("US"),
	/** Area code / national destination code. */
	areaCode: z
		.string()
		.min(1)
		.max(8)
		.regex(/^[0-9]+$/u, "must be digits only")
		.optional(),
	contains: z
		.string()
		.min(1)
		.max(15)
		.regex(/^[0-9]+$/u, "must be digits only")
		.optional(),
	numberType: z.enum(TELNYX_PHONE_NUMBER_TYPES).default("local"),
	features: z
		.union([z.enum(TELNYX_NUMBER_FEATURES), z.array(z.enum(TELNYX_NUMBER_FEATURES))])
		.transform((value) => (Array.isArray(value) ? value : [value]))
		.optional(),
	/**
	 * Capped at 50. The upper bound is not a performance concern — it is that a search returning
	 * hundreds of numbers is a list nobody reads, and every number returned is one the carrier now
	 * considers "searched" and therefore orderable.
	 */
	limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type SearchAvailableNumbersQuery = z.infer<typeof searchAvailableNumbersDto>;

/**
 * `POST /api/v1/carrier/number-orders`.
 *
 * One number per order, deliberately. Telnyx accepts several, but a partial failure across a batch
 * — three of five provisioned, two rejected on regulatory grounds — has no honest representation
 * in a single HTTP response, and the compensating logic for "we bought four but could only store
 * three" is exactly the kind of code that is written once, never exercised, and wrong when it
 * finally runs.
 *
 * The destination trio is required for the same reason it is required on
 * `POST /api/v1/phone-numbers`: "this number rings nothing" must not be expressible as a NULL
 * nobody notices. A number that costs money every month and routes nowhere is the worst version of
 * that.
 */
export const createNumberOrderDto = z.strictObject({
	e164,
	label: z.string().max(128).nullish(),
	...destinationShape(true),
	callerIdNamePrefix: z.string().max(32).nullish(),
	recordEnabled: z.boolean().optional(),
	/**
	 * The trunk whose Telnyx connection inbound calls for this DID should arrive on.
	 *
	 * Optional: a number can be ordered before a trunk is provisioned, and Telnyx will hold it
	 * unrouted. When given, the trunk must be Telnyx-managed — pointing a Telnyx DID at a BYO-SIP
	 * trunk is a configuration that cannot work, and the service refuses it rather than accepting
	 * it and letting the calls disappear.
	 */
	trunkId: z.uuid().optional(),
});

/**
 * `POST /api/v1/trunks/:id/provision-telnyx`.
 *
 * Everything is optional because the point of the endpoint is that the defaults are right: an
 * admin clicks one button and gets a registrable trunk. The knobs exist for the deployment that
 * has a reason to differ, not because a form should ask.
 */
export const provisionTrunkDto = z.strictObject({
	/**
	 * Cap on simultaneous outbound calls over this trunk at the carrier.
	 *
	 * Distinct from `trunk.maxChannels`, which the engine enforces locally: this one is enforced by
	 * Telnyx and therefore survives a compromised credential being used from somewhere that is not
	 * our engine. That is the whole point of setting it.
	 */
	concurrentCallLimit: z.int().min(1).max(1000).optional(),
	/** ISO alpha-2 destinations this trunk may dial. Defaults to the platform's configured list. */
	whitelistedDestinations: z
		.array(
			z
				.string()
				.length(2)
				.regex(/^[A-Za-z]{2}$/u),
		)
		.min(1)
		.max(50)
		.optional(),
	/** Decimal string, e.g. `"25.00"`. Defaults to the platform's configured cap. */
	dailySpendLimit: z
		.string()
		.regex(/^\d+(?:\.\d{1,2})?$/u, "must be a decimal amount such as 25.00")
		.optional(),
});

export type ProvisionTrunkBody = z.infer<typeof provisionTrunkDto>;
