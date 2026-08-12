import { z } from "zod/v4";

/**
 * The limits body.
 *
 * Every field `.nullish()`, and `null` means "no ceiling" rather than "reset to a default": there is
 * no default to reset to, because unlimited IS the default and always has been. That makes this the
 * one write DTO in this area where `null` and absent mean genuinely different things — absent leaves
 * the ceiling alone, `null` removes it — which is `patchOf`'s contract stated for a table whose
 * columns are all nullable.
 *
 * The upper bounds are not policy. They are the largest values that are not obviously a typo: a
 * hundred thousand extensions is larger than any single tenant this platform will hold, and a
 * ceiling that high is indistinguishable from none.
 */
export const writeOrgLimitsDto = z.strictObject({
	maxExtensions: z.int().min(0).max(100_000).nullish(),
	maxTrunks: z.int().min(0).max(10_000).nullish(),
	maxConcurrentCalls: z.int().min(0).max(100_000).nullish(),
	maxStorageMb: z.int().min(0).max(10_000_000).nullish(),
});
