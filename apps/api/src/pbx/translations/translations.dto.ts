import { z } from "zod/v4";
import { displayName, patchOf } from "../shared/dto";

const translationRulesetShape = {
	name: displayName,
	description: z.string().max(512).nullish(),
	enabled: z.boolean().optional(),
};

export const createTranslationRulesetDto = z.strictObject(translationRulesetShape);

export const updateTranslationRulesetDto = patchOf(z.strictObject(translationRulesetShape));

/**
 * One rewrite.
 *
 * The regex is NOT validated here beyond its length, and the replacement is NOT checked against the
 * dialable allow-list here either — both are the compiler's job, and the compile runs inside the
 * same transaction as this write. Duplicating the checks at the edge would mean two answers to
 * "is this rule usable" that can disagree, and the compiler's is the one that decides whether the
 * artifact is written. What the edge does is refuse the shapes the compiler would have to guess
 * about: an absent pattern, and a string too long to be a rewrite anybody wrote on purpose.
 *
 * The length cap bounds SIZE and nothing else. It is NOT a denial-of-service protection, and saying
 * that it was discouraged the next reader from adding the real one: catastrophic backtracking needs
 * six characters (`(a+)+$`), and the only check applied today is that `new RegExp(source)` compiles.
 * A `routes.write` holder can therefore save a pattern that compiles clean and burns CPU in the
 * engine on every outbound call it matches. The check belongs where the compile is —
 * `packages/routing/src/translations.ts`'s `validateTranslationRule`, as an `unsafe-pattern` issue
 * beside the existing `invalid-regex` — and is recorded here rather than half-built at the edge.
 *
 * There is deliberately no `matchKind`. A rule REWRITES, and the only match kind that can express a
 * rewrite is a regex with capture groups — a prefix-shaped rule is a regex with a `^`, which is one
 * concept instead of two.
 */
const translationRuleShape = {
	label: z.string().max(128).nullish(),
	matchPattern: z.string().min(1).max(256),
	/** May be empty: that is how a strip rule is written. */
	replacement: z.string().max(256),
	ordinal: z.int().min(0).max(1000),
	enabled: z.boolean().optional(),
};

export const createTranslationRuleDto = z.strictObject(translationRuleShape);

export const updateTranslationRuleDto = patchOf(z.strictObject(translationRuleShape));
