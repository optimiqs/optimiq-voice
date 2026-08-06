import { z } from "zod/v4";
import { displayName, namedDestinationShape, patchOf, resettable } from "../shared/dto";

/**
 * A park lot.
 *
 * `slotEnd >= slotStart` is a check constraint in the schema, and it is checked here too: the
 * database would refuse the row with a `23514` that this layer has no domain failure for and would
 * therefore render as a 503, which is not something a user can act on. Checking at the edge turns
 * it into a 400 addressed at `slotEnd`.
 */
const parkLotShape = {
	name: displayName,
	/** Inclusive dialable slot range, e.g. 701–720. */
	slotStart: z.int().min(1).max(99_999),
	slotEnd: z.int().min(1).max(99_999),
	/** How long a call may sit parked before the timeout branch is taken. */
	timeoutSeconds: resettable(z.int().min(5).max(86_400)),
	...namedDestinationShape("timeout"),
	mohClassId: z.uuid().nullish(),
	enabled: z.boolean().optional(),
};

function assertSlotRange(
	value: { readonly slotStart?: number | undefined; readonly slotEnd?: number | undefined },
	context: z.RefinementCtx,
): void {
	const { slotStart, slotEnd } = value;
	if (slotStart !== undefined && slotEnd !== undefined && slotEnd < slotStart) {
		context.addIssue({
			code: "custom",
			path: ["slotEnd"],
			message: "The last slot must not be lower than the first.",
		});
	}
}

export const createParkLotDto = z.strictObject(parkLotShape).superRefine(assertSlotRange);

/**
 * On PATCH the pair is only checked when BOTH ends are present.
 *
 * Moving one end past the other in a single-field PATCH is still refused — by the check constraint,
 * which sees the merged row — so nothing slips through; this just declines to guess at the half it
 * was not sent.
 */
export const updateParkLotDto = patchOf(z.strictObject(parkLotShape)).superRefine(assertSlotRange);
