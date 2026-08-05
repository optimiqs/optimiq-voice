import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
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

/** What a media object is used for. Drives retention policy and where the UI offers it. */
export const PROMPT_KINDS = ["prompt", "moh", "greeting"] as const;
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
		/** S3-style storage key. The API signs it; the engine fetches or caches it. */
		objectKey: text("object_key").notNull(),
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
		tenantIsolationPolicy("prompt"),
	],
);
