import { apiFetch } from "../api-client";

/**
 * The erasure endpoints — `POST /api/v1/erasure/preview` and `POST /api/v1/erasure`.
 *
 * ## Why the subject is a number or an extension and never an id
 *
 * An erasure request arrives on a letter naming a phone number, not a uuid. The two selectors are
 * the two ways a person appears in the ledger: an OUTSIDE party is only ever an E.164, and an
 * INSIDE party is an extension, which survives a number change. Demanding an id would push the
 * "which of our records is this person?" lookup onto the operator, which is the step that gets it
 * wrong.
 *
 * Exactly one of the two, and {@link erasureBody} is where that is enforced on this side — the
 * server refuses both and neither with its own 400, but a form that could build such a request has
 * already confused the operator about what it is going to destroy.
 *
 * ## Preview and apply return the same shape
 *
 * Deliberately, and it is what makes the confirm step honest: the counts can legitimately differ
 * between the two calls (a call can land in between), and that difference is the only evidence a
 * compliance record has. So the screen shows what actually went beside what was predicted rather
 * than assuming the preview was the outcome.
 */

/** `{ phoneNumber }` XOR `{ extension }`. Mirrors `erasureSubjectSchema` in `erasure.dto.ts`. */
export interface ErasureSubject {
	readonly phoneNumber?: string | undefined;
	readonly extension?: string | undefined;
}

/** What both routes report. Mirrors `ErasureCounts`. */
export interface ErasureCounts {
	readonly recordings: number;
	readonly voicemailMessages: number;
	readonly callLegs: number;
	/** Media objects removed from — on a preview, still sitting in — the object stores. */
	readonly objects: number;
}

/** How the operator named the subject, before it is turned into one selector or the other. */
export type ErasureSelector = "phoneNumber" | "extension";

/**
 * The request body for one selector and one value.
 *
 * Only the named key is present. Sending the other as `undefined` would serialize to an absent key
 * anyway, but the server's schema is a `strictObject` with a "exactly one" refinement, and a body
 * built by spreading both keys is one `JSON.stringify` behaviour change away from a 400 the form
 * cannot explain.
 */
export function erasureBody(selector: ErasureSelector, value: string): ErasureSubject {
	const trimmed = value.trim();
	return selector === "phoneNumber" ? { phoneNumber: trimmed } : { extension: trimmed };
}

/** Counts what an erasure WOULD affect. Changes nothing. */
export async function previewErasure(subject: ErasureSubject): Promise<ErasureCounts> {
	const { data } = await apiFetch<{ data: ErasureCounts }>("/erasure/preview", {
		method: "POST",
		body: JSON.stringify(subject),
	});
	return data;
}

/** Honours the request. Irreversible. */
export async function applyErasure(subject: ErasureSubject): Promise<ErasureCounts> {
	const { data } = await apiFetch<{ data: ErasureCounts }>("/erasure", {
		method: "POST",
		body: JSON.stringify(subject),
	});
	return data;
}

/** Whether an erasure found anything at all — a second apply legitimately reports zeroes. */
export function isEmptyErasure(counts: ErasureCounts): boolean {
	return (
		counts.recordings === 0 &&
		counts.voicemailMessages === 0 &&
		counts.callLegs === 0 &&
		counts.objects === 0
	);
}

/**
 * Whether the re-typed subject matches the one the preview was run for.
 *
 * The confirm step exists because this is the one destructive action in the product that cannot be
 * undone AND is aimed at a value the operator typed rather than a row they picked from a list. A
 * transposed digit erases somebody else's recordings and reports success, so the value has to be
 * typed twice and the two have to agree exactly.
 *
 * Trimmed on both sides — a trailing space is a paste artefact, not a different person — and
 * otherwise EXACT. Not case-insensitive: an extension is a tenant-assigned label, and folding case
 * would make `a1` and `A1` the same subject on a platform where they are two rows.
 */
export function erasureConfirmMatches(subject: string, typed: string): boolean {
	const wanted = subject.trim();
	return wanted.length > 0 && wanted === typed.trim();
}
