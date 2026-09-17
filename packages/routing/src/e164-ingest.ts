/**
 * Canonicalising the numbers a snapshot carries, at the moment the compiler reads them.
 *
 * # The problem this closes
 *
 * Every table in this package compares numbers as opaque strings. `didDefaults` is keyed by the
 * DID's `e164`; an inbound rule bound to one number matches it with `===`; the emergency ELIN is
 * whichever DID string came out of the row. That is correct only while every writer agrees on one
 * spelling — and `+441632960111`, `00441632960111` and `0044 1632 960111` are the same number to a
 * carrier and three different keys to a `Record`. A DID stored one way and presented the other is
 * an inbound route that never fires, and nothing anywhere says why.
 *
 * `@optimiq-voice/telephony`'s `normalizeE164` is the platform's single answer to that spelling
 * question, and the API's write paths already use it. This applies the SAME function to what the
 * compiler ingests, so an artifact is canonical regardless of how the row got into the database —
 * a migration, a direct SQL edit, or a release older than the API's normalisation.
 *
 * # Two kinds of number, and they are not interchangeable
 *
 * {@link ingestE164} is for a field that IS a phone number: a DID, a caller id, an ELIN. There is
 * one right spelling and anything else is a defect worth a diagnostic.
 *
 * {@link ingestDialTarget} is for a field that is a DIAL STRING — an external destination, a
 * follow-me hop. Those are matched against outbound routes whose patterns are written in the form a
 * handset dials (`NXXNXXXXXX`, `9`-prefixed, a bare extension), so normalising one to E.164 would
 * stop it matching the route that carries it. It therefore canonicalises only a target that already
 * declares itself international — `+`, `00` or `011` — where the intent is unambiguous and the
 * three spellings are genuinely one number, and leaves everything else exactly as written.
 *
 * Neither function ever DROPS a value. A number it cannot read is returned as it arrived, with the
 * reason attached: refusing to compile a tenant's routing over one malformed row would take every
 * working call down with it, and silently discarding the row would route those calls nowhere while
 * the screen still showed the number.
 */

import { isE164, normalizeE164Message, type E164Rejection } from "@optimiq-voice/telephony";

export interface NumberIngest {
	/** The canonical form, or the input verbatim when it could not be read. Never empty. */
	readonly value: string;
	/** Set when the input was not already canonical and could not be made so. */
	readonly rejection: E164Rejection | null;
	/** Whether {@link value} differs from the input. `false` for both "already canonical" and "kept". */
	readonly rewritten: boolean;
}

/**
 * A field that is a phone number, canonicalised to E.164.
 *
 * `defaultCallingCode` is the organization's country calling code, digits only. Without one a bare
 * national number is genuinely ambiguous and comes back rejected rather than guessed — see
 * `E164Options.defaultCallingCode` for why that is the safe half of the trade.
 */
export function ingestE164(input: string, defaultCallingCode?: string): NumberIngest {
	const raw = input.trim();
	if (raw.length === 0) {
		return { value: input, rejection: "empty", rewritten: false };
	}
	if (isE164(raw)) {
		return { value: raw, rejection: null, rewritten: raw !== input };
	}
	// The FLAT form, not the discriminated union: `apps/api` compiles with `strictNullChecks: false`
	// and cannot narrow `result.ok`, and this module is on its import graph. See `e164.ts`.
	const result = normalizeE164Message(raw, compactOptions(defaultCallingCode));
	return result.e164 === null
		? { value: raw, rejection: result.reason as E164Rejection, rewritten: raw !== input }
		: { value: result.e164, rejection: null, rewritten: result.e164 !== input };
}

/** The international access prefixes {@link normalizeE164} recognises, in match order. */
const INTERNATIONAL_PREFIXES = ["+", "011", "00"] as const;

/**
 * A field that is a dial string, canonicalised only when it is already international.
 *
 * A target that carries no international prefix is returned untouched and unjudged: it is a bare
 * extension, a `9`-prefixed outside line, or a national number the outbound route's own pattern is
 * written to match, and all three are correct as they stand.
 */
export function ingestDialTarget(input: string, defaultCallingCode?: string): NumberIngest {
	const raw = input.trim();
	if (raw.length === 0 || !declaresInternational(raw)) {
		return { value: raw, rejection: null, rewritten: raw !== input };
	}
	return ingestE164(raw, defaultCallingCode);
}

/** Whether a caller wrote this target as an international number. */
export function declaresInternational(value: string): boolean {
	return INTERNATIONAL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * The calling code a snapshot configured, or `undefined`.
 *
 * Accepts it with or without the `+` a person types, and refuses anything that is not one to four
 * digits with a non-zero lead — the shape of every calling code the ITU assigns. A malformed value
 * is `undefined` rather than an error here; the compiler raises the diagnostic, because this module
 * has no bag.
 */
export function readCallingCode(value: string | null | undefined): string | undefined {
	if (value == null) {
		return undefined;
	}
	const digits = value.trim().replace(/^\+/u, "");
	return /^[1-9]\d{0,3}$/u.test(digits) ? digits : undefined;
}

function compactOptions(defaultCallingCode: string | undefined) {
	return defaultCallingCode === undefined ? {} : { defaultCallingCode };
}
