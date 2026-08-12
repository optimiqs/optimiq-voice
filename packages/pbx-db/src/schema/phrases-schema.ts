import { boolean, index, integer, pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { prompt } from "./media-schema";

/**
 * Phrases — ordered prompt sequences, played wherever one prompt is played.
 *
 * # Where the phrase itself lives, and why it is not here
 *
 * A phrase IS a `prompt` row with `kind = "phrase"`. The argument is in `media-schema.ts` next to
 * `PROMPT_KINDS`, and it comes down to the eight existing `references(() => prompt.id)` foreign keys
 * that a phrase has to be storable in. This table holds only the STEPS.
 *
 * # A step names a prompt, and a step may not name a phrase
 *
 * Nesting is refused rather than bounded. A phrase whose step is another phrase is a tree, and a
 * tree is a thing the media layer would have to flatten at play time, with a depth bound nobody has
 * a reason to choose and a cycle check on the call path. The value it would add is composition
 * ("the greeting phrase, then the menu phrase"), and that is expressible today by listing the same
 * steps twice — which costs one extra row per reuse and buys a media layer that never recurses.
 * The compiler enforces it with a diagnostic rather than the database, because the constraint is
 * "the referenced row's `kind` is not `phrase`" and a check constraint cannot see another row.
 */
export const phraseStep = pgTable.withRLS(
	"phrase_step",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** The `prompt` row with `kind = "phrase"` this step belongs to. */
		phraseId: uuidEntityId("phrase_id")
			.notNull()
			.references(() => prompt.id, { onDelete: "cascade" }),
		/**
		 * The audio this step plays.
		 *
		 * `on delete restrict` rather than `cascade` or `set null`, and it is the one place in this
		 * schema that uses it. Cascading would delete the STEP when somebody removed a prompt, which
		 * silently shortens a phrase — "your call is number seven in the queue" quietly becoming
		 * "your call is number in the queue" is worse than a refused delete. `set null` is not
		 * available: a step with no audio is not a step. So deleting a prompt that a phrase uses is a
		 * 409 naming the phrase, which is what the generic reverse-reference scan already does for
		 * every other pointer.
		 */
		promptId: uuidEntityId("prompt_id")
			.notNull()
			.references(() => prompt.id, { onDelete: "restrict" }),
		ordinal: integer("ordinal").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("phrase_step_phrase_ordinal_key").on(
			table.organizationId,
			table.phraseId,
			table.ordinal,
		),
		index("phrase_step_organization_phrase_idx").on(table.organizationId, table.phraseId),
		index("phrase_step_organization_prompt_idx").on(table.organizationId, table.promptId),
		tenantIsolationPolicy("phrase_step"),
	],
);
