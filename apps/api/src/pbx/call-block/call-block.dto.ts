import { z } from "zod/v4";
import {
	CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS,
	CALL_BLOCK_MATCH_KINDS,
} from "@optimiq-voice/pbx-db";
import { patchOf } from "../shared/dto";

/**
 * What a screening rule is allowed to say.
 *
 * ## Why `pattern` is one loose string and not three validated ones
 *
 * The column holds an exact number, a prefix, or a regular expression, and which one it is is
 * `matchKind`'s business. The obvious DTO — a discriminated union that validates the string
 * against the kind — was written and then dropped, because the validation it would do is already
 * done, better, one layer down: `compilePattern` in `packages/routing` is the function whose
 * opinion decides whether a rule can be enforced, and `compileCallBlock` runs it inside the write
 * transaction. An unusable pattern is an `invalid-regex`/`invalid-pattern` **error** diagnostic,
 * which is a `RoutingCompileFailure`, which rolls the insert back and returns a 422 naming
 * `pattern`. An unanchored regex is a **warning**, which rides out in the mutation envelope and
 * renders next to the field.
 *
 * Duplicating that here would produce a second regex validator with its own opinion, and the two
 * would disagree on the first interesting input. So the DTO's job is narrower and honest: refuse
 * what is obviously not a pattern at all (empty, or longer than the column's useful range) and let
 * the compiler refuse what will not compile. The bound is a length bound rather than a character
 * class because a regex may legitimately contain almost anything.
 *
 * ## `hitCount` and `lastHitAt` are absent on purpose
 *
 * They are counters the enforcement side writes. `z.strictObject` means a client that sends one
 * gets a 400 naming the field rather than a silent drop — the difference between learning that the
 * server does not accept it and believing it was stored. They come back on every read; see the
 * resource header for why they are readable and not writable.
 *
 * ## The pairing that is NOT enforced here
 *
 * `matchKind` may be PATCHed without `pattern`, and vice versa, which is the opposite of the rule
 * `feature-codes.dto.ts` applies to `action`/`params`. The two cases differ in what the server
 * would have to guess. A feature code's `params` are meaningless against an unknown action, so the
 * DTO cannot validate them at all without the stored row. A pattern against an unknown kind is
 * merely *unvalidated at the edge* — the compile-on-write still sees both halves as they will be
 * after the write, because it reads the merged row inside the transaction. Refusing the half-patch
 * would cost a client a round trip to protect a check that happens anyway.
 */

const callBlockShape = {
	/**
	 * The number this rule screens on, read according to `matchKind`.
	 *
	 * For `direction: "inbound"` it is matched against the CALLER's number; for `"outbound"` it is
	 * matched against the DIALED string. `"both"` applies it to each in its own direction, which is
	 * how one row expresses "we do not talk to this number, in either direction".
	 */
	pattern: z.string().min(1).max(256),
	matchKind: z.enum(CALL_BLOCK_MATCH_KINDS).optional(),
	direction: z.enum(CALL_BLOCK_DIRECTIONS).optional(),
	/**
	 * What happens on a match.
	 *
	 * `allow` is not the absence of a rule — it is an entry that WINS over a `block` rule at the
	 * same specificity, which is the only way an allowlisted number escapes a broad prefix block.
	 * The compiler's sort (`allowFirst`) is where that ordering lives.
	 */
	action: z.enum(CALL_BLOCK_ACTIONS).optional(),
	label: z.string().max(128).nullish(),
	enabled: z.boolean().optional(),
};

export const createCallBlockRuleDto = z.strictObject(callBlockShape);

export const updateCallBlockRuleDto = patchOf(z.strictObject(callBlockShape));
