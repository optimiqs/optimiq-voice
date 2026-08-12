/**
 * Number-translation rulesets — the reusable half of digit manipulation.
 *
 * # What this is NOT
 *
 * It is not a replacement for `applyDigitManipulation` in `patterns.ts`. That is the INLINE
 * mechanism — "this route strips the 9 people dial for an outside line" — and it stays, because a
 * route's own outside-line habit is a fact about that route.
 *
 * This is the SHARED layer upstream calls "Number translations": a named, ordered list of
 * regex/replace pairs that several routes and several trunks point at, so "how this tenant writes a
 * number on the wire" is edited once instead of nine times, eight of which get updated.
 *
 * # A pipeline, not a first-match table
 *
 * Every enabled rule is applied in `ordinal` order and each one sees the previous one's output.
 * That is upstream's behaviour and the useful one: "strip the international prefix" and "add the
 * plus" are two steps of one normalisation, and a first-match reading would run only the first.
 * A rule that does not match is a no-op, not a failure.
 *
 * # The replacement allow-list is a security boundary, not formatting
 *
 * `applyDigitManipulation` restricts `prependDigits` to `[0-9+*#]` so that a route cannot inject SIP
 * syntax into a request URI, and the same restriction has to hold here or the shared layer becomes
 * the way around it. A replacement may therefore contain dialable characters and `$n`
 * back-references and nothing else — no `@`, no `;`, no whitespace, no `sofia/`. The check runs at
 * COMPILE time (a bad replacement is a diagnostic and the rule is dropped) rather than at apply
 * time, because the call path must not be re-validating the artifact it was handed.
 *
 * # Bounded output
 *
 * A pipeline of regexes can grow a string without limit — `(.*)` → `$1$1` doubles it every pass —
 * so the result is capped. Exceeding the cap drops the whole ruleset's effect and returns the input
 * unchanged rather than dialing something enormous, which is the same "refuse rather than guess"
 * the underflow case takes.
 */

import { RoutingError } from "./errors";

/** Upper bound on a translated number. Far past any dial string; here to bound the work. */
export const MAX_TRANSLATED_LENGTH = 128;

/** What a replacement may contain, once the back-references are removed. */
const REPLACEMENT_LITERAL_PATTERN = /^[0-9+*#]*$/u;

/** `$1` … `$9`, and `$$` for a literal dollar. Nothing else is a reference we honour. */
const BACK_REFERENCE_PATTERN = /\$(?:[1-9]|\$)/gu;

export type TranslationRuleIssue =
	| { readonly code: "invalid-regex"; readonly detail: string }
	| { readonly code: "unsafe-replacement"; readonly value: string }
	| { readonly code: "empty-pattern" };

/** One compiled rewrite, as it lives in the artifact: plain data, no `RegExp`. */
export interface CompiledTranslationRule {
	readonly id: string;
	readonly ordinal: number;
	readonly label?: string;
	readonly source: string;
	readonly replacement: string;
}

/** A compiled ruleset. `rules` is already sorted by `ordinal`. */
export interface CompiledTranslationRuleset {
	readonly id: string;
	readonly name: string;
	readonly rules: readonly CompiledTranslationRule[];
}

/** Raised when a rule that failed validation is nevertheless applied. */
export class InvalidTranslationRuleError extends RoutingError {
	readonly source: string;

	constructor(source: string, detail: string) {
		super(`Invalid translation rule ${JSON.stringify(source)}: ${detail}`);
		this.source = source;
	}
}

/**
 * Validates one rule, returning every problem rather than the first.
 *
 * Both halves are checked because both can be wrong independently: a regex that does not compile is
 * a rule that would throw on the call path, and a replacement that can emit `@` is a rule that could
 * put a second host into a request URI.
 */
export function validateTranslationRule(rule: {
	readonly matchPattern: string;
	readonly replacement: string;
}): readonly TranslationRuleIssue[] {
	const issues: TranslationRuleIssue[] = [];
	if (rule.matchPattern.length === 0) {
		issues.push({ code: "empty-pattern" });
	} else {
		try {
			// No flags, exactly as `compilePattern` does it: the stored source is the whole contract,
			// including case sensitivity.
			void new RegExp(rule.matchPattern);
		} catch (error) {
			issues.push({
				code: "invalid-regex",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (!isSafeReplacement(rule.replacement)) {
		issues.push({ code: "unsafe-replacement", value: rule.replacement });
	}
	return issues;
}

/**
 * Whether a replacement may only ever produce dialable output.
 *
 * The back-references are stripped before the literal check, because what `$1` expands to is bounded
 * by the INPUT rather than by this string — and the input is a dial string, which the caller already
 * dialed. What this stops is the literal half: a rule whose replacement is `$1@evil.example` would
 * pass a naive "does it contain a capture group" test and produce a request URI pointing somewhere
 * else entirely.
 */
export function isSafeReplacement(replacement: string): boolean {
	return REPLACEMENT_LITERAL_PATTERN.test(replacement.replaceAll(BACK_REFERENCE_PATTERN, ""));
}

const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_LIMIT = 512;

function cachedRegex(source: string): RegExp {
	const hit = regexCache.get(source);
	if (hit !== undefined) {
		return hit;
	}
	let compiled: RegExp;
	try {
		compiled = new RegExp(source);
	} catch (error) {
		throw new InvalidTranslationRuleError(
			source,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (regexCache.size >= REGEX_CACHE_LIMIT) {
		regexCache.clear();
	}
	regexCache.set(source, compiled);
	return compiled;
}

/** Test seam: drops every cached `RegExp`. Never needed in production. */
export function clearTranslationCache(): void {
	regexCache.clear();
}

/** What a ruleset did, so a diagnostic can say which rules fired. */
export interface TranslationOutcome {
	readonly value: string;
	/** Ids of the rules that changed the string, in the order they ran. Empty means "no-op". */
	readonly applied: readonly string[];
	/** True when the pipeline was abandoned because the result exceeded the length cap. */
	readonly overflowed: boolean;
}

/**
 * Runs a ruleset over a dial string.
 *
 * Only the FIRST match of each rule is replaced, not every match — `String.replace` with a
 * non-global `RegExp`. A dial string is one number, and a rule meant to strip a leading `00` that
 * silently also stripped a `00` in the middle of a subscriber number would be a bug nobody could see
 * in the ruleset. A tenant who wants every occurrence writes the repetition into the pattern.
 *
 * Never throws for an unmatched rule and never throws for an over-long result: the first is normal
 * and the second returns the INPUT unchanged with `overflowed` set, so the caller dials what the
 * user asked for rather than dialing nothing or dialing a kilobyte.
 */
export function applyTranslationRuleset(
	ruleset: CompiledTranslationRuleset,
	input: string,
): TranslationOutcome {
	const applied: string[] = [];
	let value = input;

	for (const rule of ruleset.rules) {
		const next = value.replace(cachedRegex(rule.source), rule.replacement);
		if (next === value) {
			continue;
		}
		if (next.length > MAX_TRANSLATED_LENGTH) {
			return { value: input, applied: [], overflowed: true };
		}
		value = next;
		applied.push(rule.id);
	}

	return { value, applied, overflowed: false };
}
