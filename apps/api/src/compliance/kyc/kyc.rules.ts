import type { KycDecision } from "@optimiq-voice/pbx-db";

/**
 * The two decisions the KYC write path makes, as pure functions.
 *
 * Both are here rather than inline in the service for the reason `audit-log.ts` gives for its own
 * split: a rule with regulatory weight is only worth having if it is *provable*, which means
 * testable without a pool, a session or a broker. The service opens transactions; this file decides
 * what goes in them.
 */

/**
 * The readable remainder of a tax identifier.
 *
 * Digits only, because a tax id is written with punctuation that differs by jurisdiction and by
 * typist — `12-3456789` and `123456789` are the same EIN, and a last-4 derived from raw characters
 * would render `6789` for one and `6789` for the other only by luck. Falls back to the last four
 * CHARACTERS when the identifier has fewer than four digits (some VAT numbers are letter-heavy), so
 * the column is never empty for a value that was actually supplied.
 *
 * `null` in, `null` out: clearing the tax id clears its remainder in the same write, because a
 * last-4 with no ciphertext behind it is a fragment of a secret nobody can verify.
 */
export function taxIdLast4(taxId: string | null | undefined): string | null {
	if (taxId === null || taxId === undefined) {
		return null;
	}
	const digits = taxId.replace(/\D/gu, "");
	const source = digits.length >= 4 ? digits : taxId.replace(/\s/gu, "");
	return source.length === 0 ? null : source.slice(-4);
}

/** The reviewer trio, as the amendment rule leaves it. */
export interface KycReviewReset {
	readonly decision: KycDecision;
	readonly reviewedBy: null;
	readonly reviewedAt: null;
	readonly reviewNotes: null;
}

/**
 * What a tenant amendment does to an existing verdict.
 *
 * **A decided file that is amended goes back to `pending`, and the reviewer trio is cleared.**
 *
 * This is the rule that makes the whole review worth running. An `approved` file whose legal entity
 * name, address or tax id can be edited afterwards is not an approval of anything — it is a flag
 * that says a reviewer once looked at *some* text, attached to whatever text is there now. The
 * FCC's 2026 certification regime turns "we know who this customer is" into a statement the platform
 * makes on the record; a statement that silently follows an edit is a statement about nothing.
 *
 * Returning to `pending` rather than to `needs-info` is deliberate. `needs-info` means a reviewer
 * read the file and is waiting on the customer — it is a reviewer's state, and synthesising it here
 * would put words in a reviewer's mouth. `pending` is the honest one: nobody has looked at *this*
 * version. The compliance schema says the same thing about `rejected` ("a tenant may amend and
 * resubmit, which moves it back to `pending`, and the audit log is where the history of that lives"),
 * and this is that sentence implemented for all three decided states rather than only for rejection.
 *
 * Returns `undefined` when there is nothing to reset — a first filing, or an amendment of a file
 * still awaiting its first review — so the caller writes no reviewer columns at all rather than
 * writing nulls over nulls and putting four meaningless keys in every audit diff.
 */
export function kycAmendment(
	existing: { readonly decision: KycDecision } | undefined,
): KycReviewReset | undefined {
	if (existing === undefined || existing.decision === "pending") {
		return undefined;
	}
	return { decision: "pending", reviewedBy: null, reviewedAt: null, reviewNotes: null };
}
