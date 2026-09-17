import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { uuidEntityId } from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * The media library. Audio never lives in PostgreSQL: a row holds an object-storage key plus the
 * metadata the engine and the admin UI need (duration for progress bars, checksum for cache
 * invalidation and de-duplication, size for quota accounting).
 */

/** How a music-on-hold class sources its audio. */
export const MOH_SOURCES = ["library", "stream"] as const;
export type MohSource = (typeof MOH_SOURCES)[number];

/**
 * What a media object is used for. Drives retention policy and where the UI offers it.
 *
 * # `phrase` is the odd member, and it is here rather than in a table of its own
 *
 * A phrase is an ordered sequence of other prompts played as one — "your call is number", "seven",
 * "in the queue" — which is upstream's Phrases feature and the only way to say a number aloud on a
 * platform with no text-to-speech. The question was where the row lives, and the answer is decided
 * entirely by the foreign keys that already exist: `ivr_menu.greeting_prompt_id`,
 * `queue.announce_prompt_id`, `ring_group.ringback_prompt_id` and five more all carry
 * `references(() => prompt.id)`. A phrase in a separate table could never be stored in any of them,
 * so "playable anywhere a prompt is accepted" would have meant a second nullable column beside every
 * one of those eight — eight columns, eight DTO fields, eight compiler branches, and a permanent
 * question at every site about which of the pair wins.
 *
 * A phrase IS a prompt instead, and every existing pointer accepts one for free. The price is one
 * loosened column: `prompt.object_key` becomes nullable, because a phrase has no audio of its own,
 * guarded by `prompt_object_key_kind_check` so a non-phrase still cannot exist without a file. The
 * steps live in `phrase_step`, which references `prompt.id` on both sides.
 */
export const PROMPT_KINDS = ["prompt", "moh", "greeting", "phrase"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const mohClass = pgTable.withRLS(
	"moh_class",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		description: text("description"),
		source: text("source").$type<MohSource>().notNull().default("library"),
		/** Icecast/HTTP URI when `source = "stream"`; the engine streams it instead of files. */
		streamUri: text("stream_uri"),
		shuffle: boolean("shuffle").notNull().default(true),
		sampleRateHz: integer("sample_rate_hz").notNull().default(8000),
		isDefault: boolean("is_default").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("moh_class_organization_name_key").on(table.organizationId, table.name),
		index("moh_class_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("moh_class"),
	],
);

export const prompt = pgTable.withRLS(
	"prompt",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		kind: text("kind").$type<PromptKind>().notNull().default("prompt"),
		/** Set only for `kind = "moh"`: the class this file belongs to. */
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "cascade",
		}),
		/**
		 * S3-style storage key. The API signs it; the engine fetches or caches it.
		 *
		 * Nullable ONLY for `kind = "phrase"`, which has no audio of its own — it names other rows'.
		 * `prompt_object_key_kind_check` is what keeps that from widening into "a prompt with no
		 * file", which would be a row every player has to guard against. See {@link PROMPT_KINDS}.
		 */
		objectKey: text("object_key"),
		contentType: text("content_type").notNull().default("audio/wav"),
		durationMs: integer("duration_ms"),
		sizeBytes: integer("size_bytes"),
		/** Content hash used for de-duplication and for the engine's media cache key. */
		checksum: text("checksum"),
		language: text("language").notNull().default("en-US"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("prompt_organization_name_key").on(table.organizationId, table.name),
		index("prompt_organization_kind_idx").on(table.organizationId, table.kind),
		index("prompt_organization_moh_class_idx").on(table.organizationId, table.mohClassId),
		// A phrase is the only kind with no file of its own; everything else must have one. Written
		// as one constraint over both directions so neither half can be relaxed without the other
		// being read.
		check(
			"prompt_object_key_kind_check",
			sql`(kind = 'phrase' and object_key is null) or (kind <> 'phrase' and object_key is not null)`,
		),
		tenantIsolationPolicy("prompt"),
	],
);
