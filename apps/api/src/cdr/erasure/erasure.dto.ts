import { z } from "zod/v4";
import { e164, parseDto } from "../../pbx/shared/dto";
import { CdrErasureSelectorException } from "./erasure.errors";

/**
 * Who the request is about.
 *
 * The two selectors are the two ways a person appears in this platform's records. An OUTSIDE party
 * is only ever a number — they have no account, no extension and no identifier of ours — so the
 * only handle a GDPR request can give us for them is the E.164 they called from or were called on.
 * An INSIDE party is an extension, which is a stable identifier the tenant assigned and which
 * survives a number change.
 *
 * Neither is a user id, and deliberately: an erasure request arrives naming a phone number on a
 * letter, not a uuid, and a surface that demanded the uuid would push the "which of our records is
 * this person?" lookup onto the operator — which is exactly the step that gets it wrong.
 */
export interface ErasureSubject {
	readonly phoneNumber?: string;
	readonly extension?: string;
}

/**
 * `{ phoneNumber?, extension? }`, exactly one.
 *
 * `e164` is the platform's one number normaliser (`pbx/shared/dto.ts`) and it is the STRICT arm —
 * no default calling code, so a bare national number is refused rather than guessed at. That
 * matters more here than on any other surface in the codebase: `call_legs.from_number` is written
 * in E.164 by the writer, the match below is an equality, and a selector this endpoint guessed a
 * country for would either erase nothing (and report a comforting zero) or erase the records of
 * whoever holds that number in the country we guessed.
 *
 * The "exactly one" rule lives here as a refinement so the invariant is stated with the shape, and
 * {@link parseErasureSubject} is what turns it into the endpoint's own 400 — see
 * {@link CdrErasureSelectorException} for why it is not folded into the generic body error.
 */
export const erasureSubjectSchema = z
	.strictObject({
		phoneNumber: e164.optional(),
		extension: z.string().trim().min(1).max(32).optional(),
	})
	.superRefine((value, context) => {
		if ((value.phoneNumber === undefined) === (value.extension === undefined)) {
			context.addIssue({
				code: "custom",
				message: "supply exactly one of `phoneNumber` or `extension`",
				params: { selector: true },
			});
		}
	});

/**
 * Parses a body, and distinguishes "this is not a phone number" from "you named the wrong number of
 * subjects".
 *
 * Both are 400s and a client acts on them differently: the first is a field the form can highlight,
 * the second is a request the form should not have been able to build. The selector issue is raised
 * at the ROOT of the object — there is no field to blame when the fault is which fields are present
 * — which is precisely what would make it invisible in the generic `issues[].field` rendering, so
 * it is lifted out into its own code instead.
 */
export function parseErasureSubject(value: unknown): ErasureSubject {
	const result = erasureSubjectSchema.safeParse(value ?? {});
	if (result.success) {
		return result.data;
	}
	// A FIELD issue wins over the selector issue, and the order is not cosmetic. A `phoneNumber`
	// that fails E.164 normalisation leaves the key absent from the refinement's view, so the
	// "exactly one" rule fires as collateral damage from a typo — and telling somebody they named
	// the wrong number of subjects when they actually mistyped a number sends them to the wrong fix.
	const fieldIssue = result.error.issues.some((issue) => issue.path.length > 0);
	if (!fieldIssue && result.error.issues.some((issue) => issue.path.length === 0)) {
		const body = (value ?? {}) as Record<string, unknown>;
		throw new CdrErasureSelectorException(
			["phoneNumber", "extension"].filter((key) => body[key] !== undefined && body[key] !== null),
		);
	}
	// Every other issue is an ordinary bad field, and the area answers those the way every other
	// controller in this codebase does rather than inventing a second vocabulary for them.
	return parseDto(erasureSubjectSchema, value ?? {});
}

/** What both routes report. Preview and apply share it so a client renders one table twice. */
export interface ErasureCounts {
	readonly recordings: number;
	readonly voicemailMessages: number;
	readonly callLegs: number;
	/** Media objects removed from (preview: still sitting in) the object stores. */
	readonly objects: number;
}
