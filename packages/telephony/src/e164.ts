/**
 * E.164 — the one spelling of a phone number this platform stores.
 *
 * ## Why this is normalisation and not just another regex
 *
 * Every number surface in the codebase already REFUSED a number that was not `+<digits>`, in half a
 * dozen slightly different regexes. That is a validator, and a validator is the wrong tool for a
 * field a person types: `(212) 555-0100`, `212-555-0100` and `+1 212 555 0100` are the same number,
 * and a platform that answers "must be E.164, e.g. +12125550100" to all three has made the user do
 * a conversion the machine is better at. Worse, the same number stored two ways is two rows — a DID
 * that will not match its inbound route, a block rule that blocks nothing, a duplicate check that
 * finds no duplicate.
 *
 * So there is exactly one function that turns what a person typed into what the database holds, and
 * everything else is expressed in terms of it.
 *
 * ## Why there is no libphonenumber here
 *
 * This package has zero runtime dependencies and its header says so, which is what lets the engine,
 * the control plane, the CDR writer and the routing compiler all use it. libphonenumber carries a
 * multi-megabyte metadata table to answer a question this platform does not ask: whether a national
 * number is plausible for its country's numbering plan. The carrier answers that — authoritatively,
 * and about the actual number rather than about the plan — and a local table that disagrees with
 * Telnyx is worse than no table, because it refuses numbers that work.
 *
 * What IS mechanical, and is all this needs, is the shape: strip the punctuation people type, turn
 * the international prefixes people type (`+`, `00`, `011`) into a `+`, and prepend a default
 * country calling code to what is left when the caller supplied one. That is deterministic, has no
 * table, and is wrong in exactly one way — see {@link normalizeE164}'s note on the trunk prefix.
 */

/** The strictest reading of E.164: `+`, a non-zero leading digit, and at most 15 digits total. */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/u;

/** What a person may type around the digits and mean nothing by. */
const PUNCTUATION_PATTERN = /[\s().\-/‐-― ]/gu;

/** Why a string could not be read as a number. The API turns these into a field message. */
export const E164_REJECTIONS = [
	"empty",
	"not-a-number",
	"no-country-code",
	"too-short",
	"too-long",
] as const;
export type E164Rejection = (typeof E164_REJECTIONS)[number];

export type E164Result =
	| { readonly ok: true; readonly e164: string }
	| { readonly ok: false; readonly reason: E164Rejection };

export interface E164Options {
	/**
	 * The calling code to assume when the input carries no international prefix — `"1"` for NANP,
	 * `"44"` for the UK. Digits only, no `+`.
	 *
	 * Optional, and its absence is meaningful rather than a default: with no default country a bare
	 * `2125550100` is genuinely ambiguous, and this returns `no-country-code` instead of guessing
	 * `+1` and silently routing a British extension's calls to Manhattan. A surface that has an
	 * organization's country in hand should pass it; one that does not should refuse.
	 */
	readonly defaultCallingCode?: string;
}

/** Whether a string is ALREADY canonical. Cheap, and what a stored-value assertion should use. */
export function isE164(value: string): boolean {
	return E164_PATTERN.test(value);
}

/**
 * Turn what a person typed into E.164, or say why it cannot be.
 *
 * Accepted inputs, in the order they are recognised:
 *   - `+<digits>` — already international; punctuation is stripped and it is validated.
 *   - `00<digits>` / `011<digits>` — the ITU and NANP international access prefixes, replaced by `+`.
 *   - `<digits>` with a `defaultCallingCode` — national, and the code is prepended.
 *
 * ## The trunk prefix, which is the one thing this gets deliberately wrong
 *
 * A national number is often typed with its domestic trunk prefix — `0` in most of the world, and
 * in NANP the long-distance `1` that is also the country code. Stripping a leading `0` before
 * prepending a non-NANP calling code is right nearly everywhere and is done. Stripping a leading
 * `1` under `defaultCallingCode: "1"` is right too, and is done, because `1 212 555 0100` and
 * `212 555 0100` are the same number and a NANP area code cannot begin with `1`. Neither rule is a
 * numbering-plan lookup, and both are stated here rather than hidden, because a country whose plan
 * they get wrong is a bug report with a name on it rather than a mystery.
 */
export function normalizeE164(input: string, options: E164Options = {}): E164Result {
	const flat = normalizeE164Message(input, options);
	return flat.e164 === null
		? { ok: false, reason: flat.reason as E164Rejection }
		: { ok: true, e164: flat.e164 };
}

/**
 * {@link normalizeE164} as two nullable fields plus a finished message. Exactly one of `e164` and
 * `reason` is non-null.
 *
 * This is the IMPLEMENTATION, and the union above is a thin shell over it, for a reason worth
 * stating: `apps/api` compiles with `strictNullChecks: false` (its tsconfig explains why — a ~170
 * error cleanup the module migration deliberately did not take on), and without that flag
 * TypeScript widens the `ok: true`/`ok: false` literals so `if (result.ok)` narrows nothing. A
 * discriminated union is therefore unusable in that app, and this file is compiled by it. Writing
 * the logic in the flat shape means neither this module nor its callers need a cast.
 */
export function normalizeE164Message(
	input: string,
	options: E164Options = {},
): {
	readonly e164: string | null;
	readonly reason: E164Rejection | null;
	readonly message: string | null;
} {
	const stripped = input.replace(PUNCTUATION_PATTERN, "");
	if (stripped.length === 0) {
		return reject("empty");
	}

	let digits: string;
	if (stripped.startsWith("+")) {
		digits = stripped.slice(1);
	} else if (stripped.startsWith("011")) {
		digits = stripped.slice(3);
	} else if (stripped.startsWith("00")) {
		digits = stripped.slice(2);
	} else {
		// Shape before policy: `*97` is not a phone number in any country, and answering it with
		// "no default country is configured" would send someone looking for a setting to change.
		if (!/^\d+$/u.test(stripped)) {
			return reject("not-a-number");
		}
		const callingCode = options.defaultCallingCode;
		if (callingCode === undefined || !/^[1-9]\d{0,3}$/u.test(callingCode)) {
			return reject("no-country-code");
		}
		digits = `${callingCode}${trimTrunkPrefix(stripped, callingCode)}`;
	}

	if (!/^\d+$/u.test(digits)) {
		return reject("not-a-number");
	}
	if (digits.startsWith("0")) {
		// A country calling code never begins with zero, so this is a national number that reached
		// the international branch — usually a `+` typed in front of a domestic trunk prefix.
		return reject("not-a-number");
	}
	if (digits.length < 2) {
		return reject("too-short");
	}
	if (digits.length > 15) {
		return reject("too-long");
	}
	return { e164: `+${digits}`, reason: null, message: null };
}

function reject(reason: E164Rejection) {
	return { e164: null, reason, message: describeE164Rejection(reason) };
}

function trimTrunkPrefix(national: string, callingCode: string): string {
	if (callingCode === "1") {
		// NANP: the long-distance `1` is the country code typed twice. An area code never starts
		// with 1, so an 11-digit string beginning `1` is unambiguous.
		return national.length === 11 && national.startsWith("1") ? national.slice(1) : national;
	}
	return national.startsWith("0") ? national.slice(1) : national;
}

/**
 * {@link normalizeE164} for a caller that has already decided a failure is not its problem —
 * returns the canonical form, or `null`.
 */
export function toE164(input: string, options: E164Options = {}): string | null {
	const result = normalizeE164(input, options);
	return result.ok ? result.e164 : null;
}

/** A one-line reason, for a validation message a person reads. */
export function describeE164Rejection(reason: E164Rejection): string {
	switch (reason) {
		case "empty":
			return "must not be empty";
		case "not-a-number":
			return "must contain only digits, optionally led by +, 00 or 011";
		case "no-country-code":
			return "must be international (start with +) — no default country is configured";
		case "too-short":
			return "is too short to be a phone number";
		case "too-long":
			return "is longer than the 15 digits E.164 allows";
	}
}
