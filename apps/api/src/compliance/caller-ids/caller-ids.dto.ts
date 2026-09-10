import { z } from "zod/v4";
import { CALLER_ID_VERIFICATION_METHODS } from "@optimiq-voice/pbx-db";
import { e164, patchOf } from "../../pbx/shared/dto";

/**
 * A caller id the tenant has proved a right to present.
 *
 * ## `e164` is the shared ingest, not a local regex
 *
 * `shared/dto.ts`'s `e164` normalises on the way in, which is the whole reason to reuse it here:
 * `attestationKey()` in `packages/routing` keys the right-to-use table on `+` plus digits, and a row
 * stored as `(212) 555-0100` would be a verification that silently never matches. One normaliser,
 * used by the numbers slice and by this one, is what keeps the two halves of the table — owned
 * numbers and verified numbers — in the same shape.
 *
 * ## `verifiedBy` and `verifiedAt` are absent
 *
 * The same rule as the KYC file's reviewer trio and `emergency_address.validated`: they record who
 * accepted the evidence, so accepting them from a body would let the subject of a verification sign
 * its own. `verified_at` defaults to `now()` in the schema and `verified_by` is written by the
 * service from the session.
 *
 * `expiresAt` IS writable, because it is a property of the EVIDENCE — a letter of authorisation has
 * a term, and the person filing it is the person who knows what it is.
 */
export const createVerifiedCallerIdDto = z.strictObject({
	e164,
	/** What a human calls this number: "Client's main line", "Field office". */
	label: z.string().trim().min(1).max(128).nullish(),
	verificationMethod: z.enum(CALLER_ID_VERIFICATION_METHODS),
	/** The document number, the call-back reference, the LOA id — whatever the method produced. */
	verificationReference: z.string().trim().max(256).nullish(),
	/** Object key of the stored evidence, when there is a file behind the reference. */
	evidenceObjectKey: z.string().trim().max(512).nullish(),
	/**
	 * When the right-to-use lapses. `null` means it does not.
	 *
	 * Nullable rather than mandatory because a number the tenant will present indefinitely under a
	 * standing authorisation is the common case, and forcing a date would produce a wall of
	 * `2099-01-01` rows that mean "no expiry" while looking like a policy.
	 */
	expiresAt: z.iso
		.datetime({ offset: true })
		.or(z.iso.datetime())
		.nullish()
		// A `timestamptz` column takes a Date, not a string; converted at the FIELD because that is a
		// property of the field, exactly as `country`'s upper-casing is in `emergency-addresses.dto.ts`.
		.transform((value) => (value === null || value === undefined ? value : new Date(value))),
	notes: z.string().trim().max(2048).nullish(),
});

export const updateVerifiedCallerIdDto = patchOf(createVerifiedCallerIdDto);
