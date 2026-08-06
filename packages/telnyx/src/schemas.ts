import { z } from "zod";

/**
 * Shared response primitives.
 *
 * ## The strictness policy, stated once
 *
 * Every schema here is **loose** (unknown keys pass through) and marks as `required` only the
 * fields this platform actually reads. That is a deliberate inversion of the usual "validate
 * everything" instinct, and the reasoning is worth writing down because the opposite choice is the
 * more obvious one:
 *
 * - Telnyx adds fields to these payloads without a version bump — that is what a `record_type`
 *   discriminator and an evolving REST API are for. A strict schema would turn every one of those
 *   additions into a hard outage on a code path (ordering a number) that is already the most
 *   expensive thing to have broken.
 * - Conversely, a field we *store* going missing or changing type is not a cosmetic drift: writing
 *   `undefined` into `phone_number.carrier_ref` produces a row that claims to be carrier-managed
 *   and cannot be released. That must fail loudly at the seam, which is exactly what a required
 *   field does.
 *
 * So the rule is: **required iff we persist it or branch on it.** Everything else is optional and
 * typed for convenience. `TelnyxResponseShapeError` names the offending field precisely so the
 * fix is a one-line schema edit rather than an investigation.
 *
 * Field names and enum members are pinned in `reference/telnyx-api.md`, with the doc URL each was
 * read from.
 */

/** Telnyx timestamps are ISO 8601 strings; kept as strings because nothing here does date math. */
export const telnyxTimestamp = z.string();

/** `{ "data": … }` — the envelope on every single-resource response. */
export function dataEnvelope<TSchema extends z.ZodType>(schema: TSchema) {
	return z.object({ data: schema });
}

/** `{ "data": [ … ], "meta": { … } }` — the envelope on every collection response. */
export function listEnvelope<TSchema extends z.ZodType>(schema: TSchema) {
	return z.object({
		data: z.array(schema),
		meta: z
			.looseObject({
				total_results: z.number().optional(),
				total_pages: z.number().optional(),
				page_number: z.number().optional(),
				page_size: z.number().optional(),
				best_effort_results: z.number().optional(),
			})
			.optional(),
	});
}

export type ListMeta = z.infer<ReturnType<typeof listEnvelope<z.ZodString>>>["meta"];
