import { prompt } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * The prompt library — every uploaded audio object in the tenant, in one table.
 *
 * ## One table, three uses, one `kind`
 *
 * `prompt.kind` is `"prompt" | "moh" | "greeting"`, and the three are the same THING (a row naming
 * an object key, its content type, its size and its checksum) put to three different uses. Splitting
 * them into three tables would triple the upload path, the media route and the reference guard for
 * a difference that is one column wide.
 *
 * The one that behaves differently is `"moh"`: those rows carry a `mohClassId` and are surfaced
 * under `/moh-classes/:id/files` rather than in the library list, because an MOH file is a member
 * of a class rather than a thing an IVR can be pointed at. The `prompt_organization_moh_class_idx`
 * index exists for exactly that listing.
 *
 * ## Why `prompt` IS a routing table, which it did not used to be
 *
 * For most of this table's life `affectsRouting("prompt")` was false, and correctly: the compiler
 * copies a `promptId` into a plan node **verbatim and unresolved** (`IvrMenuPlanNode.greetingPromptId`
 * and five siblings), so renaming a file or replacing its audio changed nothing the artifact
 * contained, and recompiling a tenant's whole call plan because somebody uploaded a WAV would have
 * been pure cost.
 *
 * The T2 admin block ended that, by the one route that header anticipated: a PHRASE is a `prompt`
 * row with `kind = "phrase"`, and **which prompt ids are sequences is a compiled fact** — the
 * artifact carries a phrase table the media layer expands against. So `prompt` and `phrase_step` are
 * both in `ROUTING_TABLE_TO_ENTITY` (`packages/routing/src/cache.ts`) and every write here
 * recompiles. Renaming a file still changes nothing routing reads, and the table cannot tell the two
 * apart; the cost is bounded by `isArtifactFresh`, which compares content hashes and skips the KV
 * round trip when nothing moved.
 *
 * ## The reference guard
 *
 * Eight foreign keys point at this table with `on delete set null`, so the database would accept a
 * delete and silently return an IVR to its default announcement. The area's rule is to refuse
 * instead, so all eight are declared here — the same argument `time-conditions.resource.ts` makes
 * about `time_condition_id`, with more columns.
 *
 * The ninth is `phrase_step.prompt_id`, and it is the odd one out: it is `on delete restrict`, the
 * only such column in this schema, because cascading would silently SHORTEN a phrase ("your call is
 * number seven in the queue" becoming "your call is number in the queue") and `set null` is not
 * available — a step with no audio is not a step. Declared anyway, so a prompt three phrases play
 * is a 409 naming those phrases rather than a raw foreign-key violation from the driver.
 */
export const PROMPT_RESOURCE: PbxResource = {
	kind: "prompt",
	tableName: "prompt",
	table: prompt,
	searchColumns: [prompt.name, prompt.objectKey],
	orderBy: [prompt.name, prompt.id],
	// No `enabled` column: a prompt is a file, and a file that should not play is deleted or
	// unreferenced rather than disabled. `?enabled=` therefore does nothing on this resource, which
	// is honest — the alternative is a filter that silently matches everything.
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
		// The `on delete restrict` one. Named here so the refusal is the area's 409 with the phrases
		// listed, rather than a foreign-key violation that falls through to a 503. `idColumn` points
		// the reference at the PHRASE rather than at the step, because a step has no screen and the
		// phrase does — see `ScalarReferenceSite.idColumn`.
		{
			table: "phrase_step",
			kind: "phrase",
			column: "prompt_id",
			idColumn: "phrase_id",
			nameColumn: null,
		},
	],
};
