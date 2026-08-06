import { z } from "zod";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `POST /v2/number_orders` and its reads.
 *
 * ## This endpoint is not idempotent, and that shapes the whole module
 *
 * Telnyx supports `Idempotency-Key` on seven email/storage endpoints and nowhere else — verified
 * against the OpenAPI document, not inferred (see `reference/telnyx-api.md` §Idempotency). So the
 * usual safety net is simply absent on the one call in this package that spends the customer's
 * money.
 *
 * Three things follow, and all three are load-bearing:
 *
 * 1. **The request is sent with `retryable: false`.** A socket that dies after Telnyx accepted the
 *    order but before the response arrived is indistinguishable, from here, from one that died
 *    before it was read. Retrying resolves that ambiguity in favour of ordering twice.
 * 2. **Every order carries a `customerReference` the caller supplies.** That is our own
 *    idempotency token: the API layer passes the id of the row it is about to create, so the order
 *    is permanently traceable to the write that asked for it.
 * 3. **{@link NumberOrdersResource.findByCustomerReference} exists** so an ambiguous failure is
 *    *reconciled* — "did my order actually land?" — instead of retried. That is the only correct
 *    recovery, and having it in the client means the API layer cannot forget it is required.
 *
 * `POST` returns **200**, not 201, and `GET /v2/number_orders/{number_order_id}` returns the
 * identical schema, so one parser serves both.
 */

/** The order lifecycle. Exactly three values, at both the order and the per-number level. */
export const TELNYX_ORDER_STATUSES = ["pending", "success", "failure"] as const;
export type TelnyxOrderStatus = (typeof TELNYX_ORDER_STATUSES)[number];

/**
 * The regulatory sub-status, which is NOT the order status.
 *
 * Kept as a separate tuple because conflating the two is the natural mistake: a number can be
 * `status: "pending"` with `requirements_status: "approved"` (waiting on provisioning) or
 * `status: "pending"` with `requirements_status: "requirement-info-pending"` (waiting on the
 * customer to upload an address). Those need different words in the UI.
 */
export const TELNYX_REQUIREMENTS_STATUSES = [
	"pending",
	"approved",
	"cancelled",
	"deleted",
	"requirement-info-exception",
	"requirement-info-pending",
	"requirement-info-under-review",
] as const;
export type TelnyxRequirementsStatus = (typeof TELNYX_REQUIREMENTS_STATUSES)[number];

/**
 * `status` is required — the whole point of reading an order is to learn it, and a missing one
 * would be silently treated as "not yet done" forever. Everything else is optional, per the
 * strictness policy in `schemas.ts`.
 */
const orderPhoneNumberSchema = z.looseObject({
	id: z.string().optional(),
	record_type: z.string().optional(),
	phone_number: z.string(),
	status: z.string(),
	requirements_met: z.boolean().optional(),
	requirements_status: z.string().optional(),
	country_code: z.string().optional(),
	country_iso_alpha2: z.string().optional(),
	phone_number_type: z.string().optional(),
	bundle_id: z.string().nullish(),
	regulatory_requirements: z.array(z.unknown()).optional(),
});

export const numberOrderSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	status: z.string(),
	phone_numbers: z.array(orderPhoneNumberSchema).default([]),
	phone_numbers_count: z.number().optional(),
	connection_id: z.string().nullish(),
	messaging_profile_id: z.string().nullish(),
	billing_group_id: z.string().nullish(),
	customer_reference: z.string().nullish(),
	requirements_met: z.boolean().optional(),
	sub_number_orders_ids: z.array(z.string()).optional(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxNumberOrder = z.infer<typeof numberOrderSchema>;

const orderResponse = dataEnvelope(numberOrderSchema);
const orderListResponse = listEnvelope(numberOrderSchema);

export interface CreateNumberOrderInput {
	readonly phoneNumbers: readonly string[];
	/** The credential connection the DIDs are pointed at, so inbound arrives already routed. */
	readonly connectionId?: string;
	readonly messagingProfileId?: string;
	readonly billingGroupId?: string;
	/** Our idempotency token. Required by this client even though Telnyx treats it as optional. */
	readonly customerReference: string;
}

export interface NumberOrdersResource {
	readonly create: (input: CreateNumberOrderInput) => Promise<TelnyxNumberOrder>;
	readonly get: (orderId: string) => Promise<TelnyxNumberOrder>;
	/**
	 * The reconciliation read. Returns every order stamped with the token, newest first as Telnyx
	 * returns them; the caller decides whether one of them is the order it thought it lost.
	 */
	readonly findByCustomerReference: (
		customerReference: string,
	) => Promise<readonly TelnyxNumberOrder[]>;
}

export function makeNumberOrders(transport: TelnyxTransport): NumberOrdersResource {
	return {
		create: async (input) => {
			const response = await transport.request({
				method: "POST",
				path: "/number_orders",
				// See the header. This is the one call in the package that must never auto-retry.
				retryable: false,
				body: {
					phone_numbers: input.phoneNumbers.map((phoneNumber) => ({
						phone_number: phoneNumber,
					})),
					...(input.connectionId === undefined ? {} : { connection_id: input.connectionId }),
					...(input.messagingProfileId === undefined
						? {}
						: { messaging_profile_id: input.messagingProfileId }),
					...(input.billingGroupId === undefined ? {} : { billing_group_id: input.billingGroupId }),
					customer_reference: input.customerReference,
				},
				schema: orderResponse,
			});
			return response.data;
		},

		get: async (orderId) => {
			const response = await transport.request({
				method: "GET",
				path: `/number_orders/${encodeURIComponent(orderId)}`,
				schema: orderResponse,
			});
			return response.data;
		},

		findByCustomerReference: async (customerReference) => {
			const response = await transport.request({
				method: "GET",
				path: "/number_orders",
				query: { "filter[customer_reference]": customerReference, "page[size]": 20 },
				schema: orderListResponse,
			});
			return response.data;
		},
	};
}
