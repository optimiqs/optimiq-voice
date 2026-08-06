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
 * ## Why `prompt` is NOT a routing table, and what that costs
 *
 * `affectsRouting("prompt")` is **false** — `prompt` is absent from `ROUTING_TABLE_TO_ENTITY` — so
 * every write here skips compile-on-write. That is correct today and it is worth stating why,
 * because it is correct for a reason that could stop being true:
 *
 * The compiler copies a `promptId` into a plan node **verbatim and unresolved**
 * (`IvrMenuPlanNode.greetingPromptId` and five siblings). It never looks the row up, never resolves
 * it to an object key, and never emits a dangling-prompt diagnostic. So renaming a prompt, or
 * replacing its audio, changes nothing the artifact contains — and recompiling a tenant's entire
 * call plan because somebody uploaded a file would be pure cost.
 *
 * **If that ever changes** — if the compiler starts resolving `promptId` to `object://<key>` the way
 * it already resolves `mohClassId` to a class name — then `prompt` MUST be added to
 * `ROUTING_TABLE_TO_ENTITY` in `packages/routing/src/cache.ts` in the same change, or artifacts go
 * stale the first time somebody re-uploads a greeting. Recorded here because this file is where a
 * reader asks the question.
 *
 * ## The reference guard
 *
 * Eight foreign keys point at this table and all eight are `on delete set null`, so the database
 * would accept a delete and silently return an IVR to its default announcement. The area's rule is
 * to refuse instead, so all eight are declared here — the same argument
 * `time-conditions.resource.ts` makes about `time_condition_id`, with more columns.
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
	],
};
