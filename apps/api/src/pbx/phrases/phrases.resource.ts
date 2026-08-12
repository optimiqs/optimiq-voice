import { phraseStep, prompt } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Phrases — ordered prompt sequences, playable anywhere one prompt is playable.
 *
 * ## The same table as the library, and why there is a second descriptor for it
 *
 * A phrase IS a `prompt` row with `kind = "phrase"` and a null `object_key`. The argument is in
 * `media-schema.ts` and comes down to the eight existing `references(() => prompt.id)` foreign keys
 * a phrase has to be storable in: an IVR greeting that could be a sequence but not a file would be a
 * ninth column and a second picker on every form that plays audio.
 *
 * So this descriptor names the SAME table as {@link PROMPT_RESOURCE} and differs in exactly one
 * thing that the descriptor can express — `kind`, the entity name that appears in a 404 body — and
 * one it cannot: the `kind = 'phrase'` predicate every read has to carry. `PbxResource` has no
 * vocabulary for a discriminator and is not being given one for a single caller; the predicate lives
 * in `phrases.service.ts` on the direct-read seam that `prompts.service.ts` already established for
 * `kind` and `mohClassId`. Two descriptors over one table is the cheaper half of that trade: the
 * writes still get the reference guard, the tenant transaction and compile-on-write for free, and a
 * reader asking "what can point at a phrase?" gets an answer in a `.resource.ts` file like everywhere
 * else in the area.
 *
 * ## The reference guard is the library's, minus one
 *
 * A phrase is pointed at by the same eight `*_prompt_id` columns a file is, all `on delete set null`,
 * so all eight are declared — the same argument `prompts.resource.ts` makes, for the same columns.
 *
 * `phrase_step.prompt_id` is deliberately NOT here. A step may not name a phrase (nesting is refused
 * — see `phrases-schema.ts`), so no `phrase_step` row can ever point at one of these rows, and
 * declaring the site would buy a scan that is provably always empty. It belongs on the LIBRARY's
 * descriptor instead, where it is the one pointer that can actually fire.
 */
export const PHRASE_RESOURCE: PbxResource = {
	kind: "phrase",
	tableName: "prompt",
	table: prompt,
	searchColumns: [prompt.name],
	orderBy: [prompt.name, prompt.id],
	// `prompt` has no `enabled` column that means what it means elsewhere in this area — a file that
	// should not play is deleted or unreferenced. A phrase is the same: it is the STEPS that carry
	// `enabled`, because half-building one is a real state and half-deleting a file is not.
	destinations: [],
	destinationType: null,
	scalarReferences: [
		{ table: "ivr_menu", kind: "ivr-menu", column: "greeting_prompt_id", nameColumn: "name" },
		{ table: "ivr_menu", kind: "ivr-menu", column: "short_greeting_prompt_id", nameColumn: "name" },
		{ table: "ivr_menu", kind: "ivr-menu", column: "invalid_prompt_id", nameColumn: "name" },
		{ table: "ivr_menu", kind: "ivr-menu", column: "timeout_prompt_id", nameColumn: "name" },
		{ table: "ring_group", kind: "ring-group", column: "confirm_prompt_id", nameColumn: "name" },
		{ table: "ring_group", kind: "ring-group", column: "ringback_prompt_id", nameColumn: "name" },
		{ table: "queue", kind: "queue", column: "greeting_prompt_id", nameColumn: "name" },
		{ table: "queue", kind: "queue", column: "announce_prompt_id", nameColumn: "name" },
	],
};

/**
 * One step of a phrase: an ordinal and the prompt it plays.
 *
 * `ordinalColumn` earns the collection its `PUT …/reorder`, and the order is the whole semantics
 * here in the way a translation ruleset's is: "your call is number", "seven", "in the queue" played
 * in any other order is not a slower announcement, it is a different sentence.
 *
 * `parentTable` is `prompt` — the phrase — so the generic child machinery proves the parent exists
 * in the tenant before any read or write. What it cannot prove is that the parent is a PHRASE rather
 * than a file, because that is the same discriminator {@link PHRASE_RESOURCE} explains has no place
 * in the descriptor. `requirePhrase` in `phrases.service.ts` is that half, and it runs first on every
 * path under `/phrases/:id/steps`.
 */
export const PHRASE_STEP_RESOURCE: PbxChildResource = {
	kind: "phrase-step",
	tableName: "phrase_step",
	table: phraseStep,
	// Nothing on this row is text. Search over an ordinal and two ids would match either everything
	// or nothing, and the collection is never paginated anyway — see `PbxChildResourceService`.
	searchColumns: [],
	orderBy: [phraseStep.ordinal, phraseStep.id],
	ordinalColumn: phraseStep.ordinal,
	enabledColumn: phraseStep.enabled,
	destinations: [],
	destinationType: null,
	parentColumn: phraseStep.phraseId,
	parentKind: "phrase",
	parentTable: prompt,
};
