import { z } from "zod/v4";
import {
	TELNYX_CNAM_DETAILS_MAX_LENGTH,
	TELNYX_NUMBER_FEATURES,
	TELNYX_PHONE_NUMBER_TYPES,
} from "@optimiq-voice/telnyx";
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

/**
 * `POST /api/v1/carrier/porting-orders`.
 *
 * A batch, unlike `createNumberOrderDto` above, and the asymmetry is deliberate rather than an
 * inconsistency. An order is refused one number at a time because a partial failure across a batch
 * has no honest HTTP representation; a **port** has no such problem, because the carrier itself
 * models the batch — it splits the request into one porting order per losing carrier and answers
 * with all of them. Forcing one number per request would therefore produce more orders at Telnyx
 * than the customer asked for, each with its own FOC date, which is worse for exactly the people
 * porting a block of DIDs.
 *
 * Capped at 100 because that is the point past which the response stops being something a human
 * reviews before the port is filed.
 */
export const createPortingOrderDto = z.strictObject({
	e164s: z.array(e164).min(1).max(100),
});

export type CreatePortingOrderBody = z.infer<typeof createPortingOrderDto>;

/**
 * `GET /api/v1/carrier/porting-orders`.
 *
 * `status` is a free string rather than a `z.enum`, deliberately: the enum in
 * `@optimiq-voice/telnyx` exists so the UI can label a status it received, not so this DTO can
 * refuse one it has not heard of. A carrier adding a lifecycle state must not turn "show me my
 * ports" into a 400.
 */
export const listPortingOrdersDto = z.strictObject({
	status: z.string().min(1).max(40).optional(),
	pageSize: z.coerce.number().int().min(1).max(100).default(25),
	pageNumber: z.coerce.number().int().min(1).default(1),
});

export type ListPortingOrdersQueryBody = z.infer<typeof listPortingOrdersDto>;

/**
 * `PATCH /api/v1/carrier/numbers/:id/cnam`.
 *
 * Two switches and a string, because CNAM genuinely has two switches: `enabled` presents a name on
 * outbound calls at all, `listingEnabled` is the listing record itself. Collapsing them into one
 * boolean would be a friendlier form and a lie — the carrier can and does hold them independently,
 * and a UI that showed one toggle would flip the wrong half.
 *
 * The 15-character ceiling is the NANP CNAM field width, enforced again here rather than only in
 * the client so the caller gets a 400 with a field name instead of a 502 wrapping a client throw.
 */
export const updateCnamListingDto = z
	/**
	 * The emptiness check runs BEFORE the field schemas, through a pipe, rather than as a `.refine`
	 * on the object.
	 *
	 * A refine would also fire on a body that set exactly one field badly — a 16-character name
	 * would come back as "too big" AND "supply at least one of…", the second of which is untrue and
	 * is the one a form would render next to the wrong control. Ordering the checks makes each error
	 * message true of the request that produced it.
	 */
	.looseObject({})
	.refine((value) => Object.keys(value).length > 0, {
		message: "supply at least one of enabled, listingEnabled or details",
	})
	.pipe(
		z.strictObject({
			enabled: z.boolean().optional(),
			listingEnabled: z.boolean().optional(),
			details: z
				.string()
				.max(TELNYX_CNAM_DETAILS_MAX_LENGTH)
				.regex(/^[\x20-\x7E]*$/u, "must be printable ASCII")
				.optional(),
		}),
	);

export type UpdateCnamListingBody = z.infer<typeof updateCnamListingDto>;
