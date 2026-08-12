import { z } from "zod/v4";
import { displayName, patchOf, resettable } from "../shared/dto";

/**
 * A PIN set.
 *
 * Nothing here reaches a secret. The codes live on the entries and are set through a dedicated
 * endpoint that hashes them, for the reason `pins-schema.ts` gives at length: a PIN is a bearer
 * credential for spending money, and a column an admin form can round-trip is a column in every
 * backup and every read replica.
 */
const pinSetShape = {
	name: displayName,
	description: z.string().max(512).nullish(),
	promptId: z.uuid().nullish(),
	failurePromptId: z.uuid().nullish(),
	/**
	 * Three is the universal telephone answer and the bound below it is the reason: a four-digit PIN
	 * behind unbounded retries is a keypad away from being brute forced during one long call, and
	 * each attempt costs the attacker nothing. Ten at the top is already generous.
	 */
	maxAttempts: resettable(z.int().min(1).max(10)),
	digitTimeoutMs: resettable(z.int().min(1000).max(60_000)),
	enabled: z.boolean().optional(),
};

export const createPinSetDto = z.strictObject(pinSetShape);

export const updatePinSetDto = patchOf(z.strictObject(pinSetShape));

/**
 * One code's metadata — and deliberately not the code.
 *
 * `label` and `ordinal` are what a CDR records, which is the whole of what upstream's plaintext
 * column was needed for: "which of our codes placed this call" is answerable from an identity, not
 * from a secret.
 */
const pinSetEntryShape = {
	label: z.string().max(128).nullish(),
	ordinal: z.int().min(0).max(1000),
	enabled: z.boolean().optional(),
};

export const createPinSetEntryDto = z.strictObject(pinSetEntryShape);

export const updatePinSetEntryDto = patchOf(z.strictObject(pinSetEntryShape));

/**
 * Setting a code.
 *
 * Its own endpoint rather than a field, exactly as a mailbox PIN is: the value is hashed on the way
 * in and never comes back out, and a field on the ordinary PATCH would make "did that save?" a
 * question the response cannot answer.
 *
 * Four digits at the bottom because that is the shortest anybody actually uses, and refusing three
 * is a cheap floor on a credential whose search space is the whole of its security.
 */
export const setPinDto = z.strictObject({
	pin: z
		.string()
		.min(4)
		.max(16)
		.regex(/^[0-9]+$/u, "must be digits only"),
});
