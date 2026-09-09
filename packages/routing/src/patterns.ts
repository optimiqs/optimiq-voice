/**
 * Number matching: the four match kinds, their specificity ordering, and digit manipulation.
 *
 * # Specificity is a compile-time fact, not a runtime search
 *
 * FreeSWITCH evaluates dialplan extensions strictly top to bottom and stops at the first match,
 * which makes "why did my new rule never fire?" the single most common PBX support question. Our
 * routes carry an explicit `priority`, but priority alone still lets a tenant put `any` above a
 * specific DID and silently shadow it. So the compiler sorts by (priority, specificity, tie-break)
 * and *reports* the shadowing it finds. Runtime then does a linear walk of an already-correct
 * order — no scoring, no surprises.
 *
 * Specificity ranks: `exact` > `prefix` (longer first) > `regex` > `any`. A regex sits below every
 * prefix because its selectivity is not computable, and guessing would make ordering depend on the
 * cleverness of the guess.
 *
 * # Regexes are not anchored for you
 *
 * A tenant's `^\+1555` means what it says, and rewriting it to `^(?:…)$` behind their back would
 * change which calls match. Instead an unanchored pattern raises the `unanchored-regex` warning,
 * because on an *outbound* route an unanchored pattern is how `+1900…` sneaks through a rule that
 * was meant to match `555`.
 */

import { RoutingError } from "./errors";
import type { RouteMatchKind } from "./snapshot";

/** Upper bound on a stored pattern. Long enough for any real dial plan, short enough to bound work. */
export const MAX_PATTERN_LENGTH = 256;

/** A pattern as it lives in the artifact: plain data, JSON round-trippable, no `RegExp`. */
export type CompiledPattern =
	| { readonly kind: "exact"; readonly value: string }
	| { readonly kind: "prefix"; readonly value: string }
	| { readonly kind: "regex"; readonly source: string }
	| { readonly kind: "any" };

export interface PatternMatch {
	/** Regex capture groups 1..n, in order. Empty for every other kind. */
	readonly captures: readonly string[];
}

export type PatternIssue =
	| { readonly code: "empty-pattern" }
	| { readonly code: "pattern-too-long"; readonly length: number }
	| { readonly code: "invalid-regex"; readonly detail: string }
	| { readonly code: "unanchored-regex" };

/**
 * Whether a regex source can backtrack catastrophically, as a rejection reason or `null`.
 *
 * `MAX_PATTERN_LENGTH` bounds a pattern's LENGTH, which is not the same thing: `^(a+)+$` fits in
 * eight characters and takes exponential time on a non-matching input. These patterns are evaluated
 * per call against carrier-supplied values (`InboundRule.callerPattern`, every call-block rule), and
 * Node has no regex timeout, so a bad one is unrecoverable at runtime and has to be refused at
 * write time.
 *
 * The test is the classic shape and deliberately nothing cleverer: a group that is itself repeated
 * without an upper bound, whose body can also match the same text more than one way — an inner
 * unbounded quantifier (`(a+)+`, `(a*)*`) or an alternation (`(a|a)*`). Proving non-exponentiality
 * in general needs a different engine; this catches what a tenant actually writes by accident and
 * never rejects a pattern with bounded repetition.
 */
export function unsafeRegexDetail(source: string): string | null {
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i];
		if (char === "\\") {
			i += 1;
			continue;
		}
		if (char === "[") {
			i = endOfCharacterClass(source, i);
			continue;
		}
		if (char !== "(") {
			continue;
		}
		const close = endOfGroup(source, i);
		if (close === -1) {
			continue;
		}
		if (!isUnboundedQuantifier(source, close + 1)) {
			continue;
		}
		const body = source.slice(i + 1, close);
		if (hasUnboundedQuantifier(body) || hasAlternation(body)) {
			return `nested unbounded repetition in ${JSON.stringify(source.slice(i, close + 2))} can backtrack catastrophically`;
		}
	}
	return null;
}

function endOfCharacterClass(source: string, start: number): number {
	for (let i = start + 1; i < source.length; i += 1) {
		if (source[i] === "\\") {
			i += 1;
		} else if (source[i] === "]") {
			return i;
		}
	}
	return source.length;
}

/** Index of the `)` closing the `(` at `start`, or -1 when the group is unterminated. */
function endOfGroup(source: string, start: number): number {
	let depth = 0;
	for (let i = start; i < source.length; i += 1) {
		const char = source[i];
		if (char === "\\") {
			i += 1;
		} else if (char === "[") {
			i = endOfCharacterClass(source, i);
		} else if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

/** Whether the token at `index` repeats without an upper bound: `*`, `+`, or `{n,}`. */
function isUnboundedQuantifier(source: string, index: number): boolean {
	const char = source[index];
	if (char === "*" || char === "+") {
		return true;
	}
	if (char !== "{") {
		return false;
	}
	const close = source.indexOf("}", index);
	return close !== -1 && /^\{\d*,\}$/u.test(source.slice(index, close + 1));
}

function hasUnboundedQuantifier(body: string): boolean {
	for (let i = 0; i < body.length; i += 1) {
		if (body[i] === "\\") {
			i += 1;
		} else if (body[i] === "[") {
			i = endOfCharacterClass(body, i);
		} else if (isUnboundedQuantifier(body, i)) {
			return true;
		}
	}
	return false;
}

function hasAlternation(body: string): boolean {
	for (let i = 0; i < body.length; i += 1) {
		if (body[i] === "\\") {
			i += 1;
		} else if (body[i] === "[") {
			i = endOfCharacterClass(body, i);
		} else if (body[i] === "|") {
			return true;
		}
	}
	return false;
}

/** Raised when a pattern that failed validation is nevertheless handed to the matcher. */
export class InvalidPatternError extends RoutingError {
	readonly source: string;

	constructor(source: string, detail: string) {
		super(`Invalid routing pattern ${JSON.stringify(source)}: ${detail}`);
		this.source = source;
	}
}

/**
 * Turns a stored (matchKind, pattern) pair into a compiled pattern plus any issues found.
 *
 * Returns both rather than throwing: the caller is the validation pass, which wants every problem
 * in the tenant's configuration at once. A pattern with an `invalid-regex` issue still returns a
 * compiled value so downstream code has something to attach a diagnostic to; the compiler drops
 * the owning rule before the artifact is built.
 */
export function compilePattern(
	kind: RouteMatchKind,
	pattern: string | null | undefined,
): { readonly pattern: CompiledPattern; readonly issues: readonly PatternIssue[] } {
	if (kind === "any") {
		return { pattern: { kind: "any" }, issues: [] };
	}

	const raw = pattern ?? "";
	const issues: PatternIssue[] = [];
	if (raw.length === 0) {
		issues.push({ code: "empty-pattern" });
	}
	if (raw.length > MAX_PATTERN_LENGTH) {
		issues.push({ code: "pattern-too-long", length: raw.length });
	}

	if (kind === "regex") {
		const detail = regexCompileError(raw);
		if (detail !== null) {
			issues.push({ code: "invalid-regex", detail });
		} else if (!raw.startsWith("^") && !raw.endsWith("$")) {
			issues.push({ code: "unanchored-regex" });
		}
		return { pattern: { kind: "regex", source: raw }, issues };
	}

	return { pattern: { kind, value: raw }, issues };
}

function regexCompileError(source: string): string | null {
	try {
		// No flags: the stored pattern is the whole contract, including case sensitivity.
		void new RegExp(source);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	// Compilability is not safety: see `unsafeRegexDetail`.
	return unsafeRegexDetail(source);
}

/**
 * Bounded cache of compiled `RegExp` objects.
 *
 * The artifact stores regex *sources* because it has to survive JSON, so every match would
 * otherwise recompile. The cache is capped and cleared wholesale when full: routing patterns per
 * process are counted in hundreds, and an LRU would be more machinery than the problem deserves.
 */
const REGEX_CACHE_LIMIT = 512;
const regexCache = new Map<string, RegExp>();

function cachedRegex(source: string): RegExp {
	const hit = regexCache.get(source);
	if (hit !== undefined) {
		return hit;
	}
	let compiled: RegExp;
	try {
		compiled = new RegExp(source);
	} catch (error) {
		throw new InvalidPatternError(source, error instanceof Error ? error.message : String(error));
	}
	if (regexCache.size >= REGEX_CACHE_LIMIT) {
		regexCache.clear();
	}
	regexCache.set(source, compiled);
	return compiled;
}

/** Test seam: drops every cached `RegExp`. Never needed in production. */
export function clearPatternCache(): void {
	regexCache.clear();
}

/** Matches `input` against a compiled pattern. `null` means no match. */
export function matchPattern(pattern: CompiledPattern, input: string): PatternMatch | null {
	switch (pattern.kind) {
		case "any": {
			return { captures: [] };
		}
		case "exact": {
			return pattern.value === input ? { captures: [] } : null;
		}
		case "prefix": {
			return input.startsWith(pattern.value) ? { captures: [] } : null;
		}
		default: {
			const result = cachedRegex(pattern.source).exec(input);
			if (result === null) {
				return null;
			}
			return { captures: result.slice(1).map((group) => group ?? "") };
		}
	}
}

/**
 * Ordering weight. Higher is more specific, so a descending sort puts the rule that should win
 * first. `prefix` folds its length into the score, which is what makes longest-prefix-wins fall
 * out of a plain sort rather than a special case at match time.
 */
export function patternSpecificity(pattern: CompiledPattern): number {
	switch (pattern.kind) {
		case "exact": {
			return 1_000_000;
		}
		case "prefix": {
			// Bounded by MAX_PATTERN_LENGTH, so a prefix can never reach `exact` or fall to `regex`.
			return 1_000 + Math.min(pattern.value.length, MAX_PATTERN_LENGTH);
		}
		case "regex": {
			return 10;
		}
		default: {
			return 0;
		}
	}
}

/**
 * Whether `left` matches every input `right` does (and possibly more). Used to detect a rule that
 * can never fire because an earlier one swallows it.
 *
 * Deliberately conservative: regex containment is undecidable in general, so only the cases that
 * are certain are reported. A missed shadowing is a missing warning; a wrong one would teach
 * tenants to ignore the warnings.
 */
export function patternSubsumes(left: CompiledPattern, right: CompiledPattern): boolean {
	if (left.kind === "any") {
		return true;
	}
	if (right.kind === "any") {
		return false;
	}
	if (left.kind === "prefix") {
		if (right.kind === "prefix" || right.kind === "exact") {
			return right.value.startsWith(left.value);
		}
		return false;
	}
	if (left.kind === "exact") {
		return right.kind === "exact" && right.value === left.value;
	}
	return right.kind === "regex" && right.source === left.source;
}

/** Whether two patterns can match the same input at all. */
export function patternsOverlap(left: CompiledPattern, right: CompiledPattern): boolean {
	if (left.kind === "any" || right.kind === "any") {
		return true;
	}
	if (left.kind === "regex" || right.kind === "regex") {
		// Only identical sources are provably overlapping; see `patternSubsumes`.
		return left.kind === "regex" && right.kind === "regex" && left.source === right.source;
	}
	if (left.kind === "exact" && right.kind === "exact") {
		return left.value === right.value;
	}
	if (left.kind === "exact") {
		return left.value.startsWith((right as { value: string }).value);
	}
	if (right.kind === "exact") {
		return right.value.startsWith(left.value);
	}
	return left.value.startsWith(right.value) || right.value.startsWith(left.value);
}

/** Digit manipulation as stored on an outbound route. */
export interface DigitManipulation {
	readonly stripDigits: number;
	readonly prependDigits: string | null;
}

/** What may be prepended: dialable characters only, so a route cannot inject SIP syntax. */
const PREPEND_PATTERN = /^[0-9+*#]{0,32}$/;

export type DigitManipulationIssue =
	| { readonly code: "negative-strip" }
	| { readonly code: "strip-too-large"; readonly strip: number }
	| { readonly code: "invalid-prepend"; readonly value: string };

/** Bound on `stripDigits`; nothing real strips more than a country code plus a trunk prefix. */
export const MAX_STRIP_DIGITS = 32;

export function validateDigitManipulation(
	manipulation: DigitManipulation,
): readonly DigitManipulationIssue[] {
	const issues: DigitManipulationIssue[] = [];
	if (!Number.isInteger(manipulation.stripDigits) || manipulation.stripDigits < 0) {
		issues.push({ code: "negative-strip" });
	} else if (manipulation.stripDigits > MAX_STRIP_DIGITS) {
		issues.push({ code: "strip-too-large", strip: manipulation.stripDigits });
	}
	const prepend = manipulation.prependDigits ?? "";
	if (!PREPEND_PATTERN.test(prepend)) {
		issues.push({ code: "invalid-prepend", value: prepend });
	}
	return issues;
}

/**
 * Applies strip-then-prepend to a dialed string.
 *
 * `null` means the manipulation would consume the whole number, which is a configuration error the
 * resolver reports as `digit-manipulation-underflow` rather than dialing an empty destination.
 */
export function applyDigitManipulation(
	manipulation: DigitManipulation,
	dialed: string,
): string | null {
	if (manipulation.stripDigits > dialed.length) {
		return null;
	}
	const stripped = dialed.slice(manipulation.stripDigits);
	const result = `${manipulation.prependDigits ?? ""}${stripped}`;
	return result.length === 0 ? null : result;
}
