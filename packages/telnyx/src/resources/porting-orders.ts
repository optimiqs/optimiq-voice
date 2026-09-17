import { z } from "zod";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { ListMeta } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/porting_orders` — porting a number IN from a losing carrier (LNP).
 *
 * ## `POST` returns a LIST, and that is the whole shape of this module
 *
 * Every other creation call in this package answers with one object. This one answers with
 * `{ "data": [ … ] }`, because Telnyx **splits a requested set of numbers into one porting order
 * per losing carrier and number type**: hand it four numbers spread over two carriers and you get
 * two orders back, each with its own `support_key`, its own FOC date and its own exception list.
 * Modelling the create as "returns a porting order" would therefore be a lie that goes undetected
 * for exactly as long as every customer ports from a single carrier — i.e. until the first
 * interesting port. So {@link PortingOrdersResource.create} returns an array, and the caller is
 * forced to decide what to do when it holds more than one.
 *
 * ## A port-in is a purchase, and it is not idempotent
 *
 * Telnyx offers `Idempotency-Key` on seven endpoints and this is not one of them (see
 * `reference/telnyx-api.md` §Idempotency), so this module borrows `number-orders.ts`'s three
 * defences wholesale, for the same reason: a port-in commits the organization to a recurring bill
 * and to a carrier-side workflow a human then has to unwind by hand.
 *
 * 1. **`retryable: false` on the create.** A socket that dies after Telnyx accepted the port is
 *    indistinguishable from one that died before it read the request. Retrying resolves that
 *    ambiguity in favour of filing the port twice.
 * 2. **`customerReference` is required by this client** even though Telnyx treats it as optional.
 *    It is our idempotency token.
 * 3. **{@link PortingOrdersResource.findByCustomerReference}** exists so an ambiguous failure is
 *    *reconciled* rather than retried — the only correct recovery, and putting it in the client
 *    means the API layer cannot forget it is required.
 *
 * ## What is NOT here
 *
 * No document upload, no end-user detail, no LOA generation, no `PATCH` of a draft order, and no
 * port-OUT. Those are a multi-screen regulatory workflow, and modelling half of it would produce
 * a client that looks like it can complete a port and cannot. What this covers is the honest
 * subset: **file the port, list what is in flight, read one order's status**. An order that needs
 * documents comes back `status: "draft"` with `documents` unset, which is a state the caller can
 * see and report rather than one it silently mistakes for progress.
 *
 * **Shape provenance:** unlike the rest of this package, `reference/telnyx-api.md` does not cover
 * porting. Field names, the list-shaped `POST` response and the status enum below were taken from
 * the public Telnyx v2 API rather than read from the pinned OpenAPI document, and are therefore
 * the most likely thing in this package to drift. Every schema here is loose and almost entirely
 * optional for that reason: an unmodelled field must not break a status read on a port a customer
 * is waiting for.
 */

/**
 * The porting-order lifecycle.
 *
 * Worth reading as three groups, because the UI needs different words for each: **ours to act on**
 * (`draft`, `exception`), **theirs to act on** (`in-process`, `submitted`, `foc-date-confirmed`,
 * `cancel-pending`), and **terminal** (`ported`, `cancelled`). `exception` is the one that costs
 * money to ignore — it means the losing carrier rejected something and the port is stalled until
 * a human answers.
 */
export const TELNYX_PORTING_ORDER_STATUSES = [
	"draft",
	"in-process",
	"submitted",
	"exception",
	"foc-date-confirmed",
	"cancel-pending",
	"ported",
	"cancelled",
] as const;
export type TelnyxPortingOrderStatus = (typeof TELNYX_PORTING_ORDER_STATUSES)[number];

/** Per-number activation state, which is NOT the order status. A `ported` order can still hold
 * numbers that have not cut over yet. */
export const TELNYX_PORTING_ACTIVATION_STATUSES = [
	"New",
	"Pending",
	"Conflict",
	"Cancelled",
	"Completed",
	"Failed",
] as const;
export type TelnyxPortingActivationStatus = (typeof TELNYX_PORTING_ACTIVATION_STATUSES)[number];

const portingPhoneNumberSchema = z.looseObject({
	id: z.string().optional(),
	record_type: z.string().optional(),
	phone_number: z.string(),
	porting_order_status: z.string().optional(),
	activation_status: z.string().optional(),
	phone_number_type: z.string().optional(),
	portability_status: z.string().optional(),
});

/**
 * `id` and `status` are required; everything else is optional.
 *
 * Per the strictness policy in `schemas.ts`, required iff we persist it or branch on it. We store
 * the id (it is the handle for every subsequent read) and branch on the status (it is the entire
 * reason anyone reads a porting order), and nothing else meets that bar — least of all fields
 * whose names were inferred rather than read.
 */
export const portingOrderSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	status: z.string(),
	customer_reference: z.string().nullish(),
	/** The number the losing carrier's support desk quotes back. Put it in front of the operator. */
	support_key: z.string().nullish(),
	phone_numbers: z.array(portingPhoneNumberSchema).default([]),
	phone_numbers_count: z.number().optional(),
	activation_settings: z
		.looseObject({
			/** The confirmed cutover moment, once the losing carrier grants one. */
			foc_datetime_requested: telnyxTimestamp.nullish(),
			foc_datetime_actual: telnyxTimestamp.nullish(),
			fast_port_eligible: z.boolean().optional(),
		})
		.optional(),
	misc: z
		.looseObject({
			type: z.string().nullish(),
			remaining_numbers_action: z.string().nullish(),
		})
		.optional(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxPortingOrder = z.infer<typeof portingOrderSchema>;

const portingOrderResponse = dataEnvelope(portingOrderSchema);
const portingOrderListResponse = listEnvelope(portingOrderSchema);

export interface CreatePortingOrderInput {
	/** The numbers to port in, E.164. Telnyx may split them across several returned orders. */
	readonly phoneNumbers: readonly string[];
	/** Our idempotency token. Required by this client even though Telnyx treats it as optional. */
	readonly customerReference: string;
}

export interface ListPortingOrdersQuery {
	readonly status?: string;
	readonly customerReference?: string;
	readonly pageSize?: number;
	readonly pageNumber?: number;
}

export interface PortingOrdersResource {
	/**
	 * Files the port. Returns **every** order Telnyx created, not one — see the module header.
	 *
	 * Never auto-retried: this is the call that commits the organization to the port.
	 */
	readonly create: (input: CreatePortingOrderInput) => Promise<readonly TelnyxPortingOrder[]>;
	/**
	 * One page of porting orders, with the metadata Telnyx sent.
	 *
	 * `meta` is returned rather than discarded because this list is admin-facing and silently
	 * truncated otherwise: without `total_pages` a caller cannot tell "no other ports in flight"
	 * from "the first twenty of them".
	 */
	readonly list: (query?: ListPortingOrdersQuery) => Promise<{
		readonly data: readonly TelnyxPortingOrder[];
		readonly meta: ListMeta;
	}>;
	/** One order's current state. The status read. */
	readonly get: (portingOrderId: string) => Promise<TelnyxPortingOrder>;
	/**
	 * The reconciliation read. Every order stamped with the token, newest first — sorted here
	 * rather than trusted from the API, whose default ordering for this endpoint is not documented
	 * and is therefore not something a caller may rely on.
	 */
	readonly findByCustomerReference: (
		customerReference: string,
	) => Promise<readonly TelnyxPortingOrder[]>;
}

/** `created_at` as a sortable number. An order without one sorts oldest, never first. */
function orderedAt(order: TelnyxPortingOrder): number {
	const parsed = order.created_at === undefined ? Number.NaN : Date.parse(order.created_at);
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function makePortingOrders(transport: TelnyxTransport): PortingOrdersResource {
	const list = async (query: ListPortingOrdersQuery = {}) => {
		const response = await transport.request({
			method: "GET",
			path: "/porting_orders",
			query: {
				"filter[status]": query.status,
				"filter[customer_reference]": query.customerReference,
				"page[size]": query.pageSize,
				"page[number]": query.pageNumber,
			},
			schema: portingOrderListResponse,
		});
		return { data: response.data, meta: response.meta };
	};

	return {
		create: async (input) => {
			const response = await transport.request({
				method: "POST",
				path: "/porting_orders",
				// See the header. A repeated port-in is a second regulatory workflow and a second bill.
				retryable: false,
				body: {
					phone_numbers: [...input.phoneNumbers],
					customer_reference: input.customerReference,
				},
				// The create answers with the LIST envelope, not the single-resource one.
				schema: portingOrderListResponse,
			});
			return response.data;
		},

		list,

		get: async (portingOrderId) => {
			const response = await transport.request({
				method: "GET",
				path: `/porting_orders/${encodeURIComponent(portingOrderId)}`,
				schema: portingOrderResponse,
			});
			return response.data;
		},

		findByCustomerReference: async (customerReference) => {
			const { data } = await list({ customerReference, pageSize: 20 });
			return [...data].sort((left, right) => orderedAt(right) - orderedAt(left));
		},
	};
}
