import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, namedDestinationColumns } from "./columns";

/** Which part of an extension's label a caller spells. */
export const DIRECTORY_SEARCH_FIELDS = ["last-name", "first-name", "full-name"] as const;

export type DirectorySearchField = (typeof DIRECTORY_SEARCH_FIELDS)[number];

/**
 * Dial-by-name directory — "please spell the first three letters of the surname".
 *
 * # The recorded name is the whole feature, and it is why the compiler skips people
 *
 * Upstream plays a mailbox's recorded NAME greeting when it offers a match ("for John Smith, press
 * one"). This platform has no text-to-speech — the parity audit records `VOICEMAIL_GREETING_KINDS`
 * already containing `"name"` with no consumer anywhere, which is precisely the asset this feature
 * exists to consume — so the recording is not an enhancement here, it is the only way a match can be
 * spoken at all.
 *
 * An extension whose mailbox has no active `name` greeting is therefore SKIPPED: it is compiled out
 * of the digit map entirely, and the compiler raises a warning naming it. The alternatives were both
 * worse. Offering the match silently gives the caller "for … press one" with a gap where the name
 * should be, which reads as a broken phone system. Spelling the name back with per-letter prompt
 * files needs twenty-six recordings this platform does not ship and produces "for J-O-H-N space
 * S-M-I-T-H", which nobody wants to listen to. Skipping is the honest behaviour and the warning is
 * what makes it visible: a tenant who wonders why Jane is not in the directory is told, in the
 * diagnostics, that Jane has not recorded her name.
 *
 * # The digit map is compiled, not searched at call time
 *
 * `matchDigits` for every eligible extension is built into the artifact — the letters of the chosen
 * name part, mapped through the ITU keypad — so the engine matches a prefix against a table it
 * already holds. The engine has no database handle, which is the same reason every other index in
 * the artifact exists; and doing it at compile time is also what lets the compiler report the case
 * that has no runtime symptom at all: two people whose names collide on the keypad.
 */
export const dialByNameDirectory = pgTable.withRLS(
	"dial_by_name_directory",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/** Dialable number for the directory, when it has one. Nullable, like every other entity's. */
		extensionNumber: text("extension_number"),
		/**
		 * Which part of an extension's label a caller is spelling.
		 *
		 * `last-name` is the default because it is what every directory a caller has ever used asks
		 * for. `full-name` matches the digits of the whole label with the spaces removed, which is the
		 * forgiving option for a tenant whose labels are not "Given Family".
		 */
		searchField: text("search_field").$type<DirectorySearchField>().notNull().default("last-name"),
		/**
		 * How many digits the caller must enter before matching starts.
		 *
		 * Three is upstream's number and it is not arbitrary: one digit on a fifty-seat tenant matches
		 * a third of the building, and the caller then listens to a list. The floor of two is here
		 * because a two-letter surname exists; the ceiling of six is past any useful discrimination.
		 */
		minDigits: integer("min_digits").notNull().default(3),
		/** "Please spell the first three letters of the surname." Falls back to the engine's own. */
		greetingPromptId: uuidEntityId("greeting_prompt_id"),
		/** Played when nothing matched, before the caller is offered another try. */
		invalidPromptId: uuidEntityId("invalid_prompt_id"),
		/** How many failed attempts before the timeout branch is taken. */
		maxFailures: integer("max_failures").notNull().default(3),
		/** Where the call goes when the caller gives up, times out or exhausts their attempts. */
		...namedDestinationColumns("timeout"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("dial_by_name_directory_organization_name_key").on(
			table.organizationId,
			table.name,
		),
		uniqueIndex("dial_by_name_directory_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		index("dial_by_name_directory_organization_enabled_idx").on(
			table.organizationId,
			table.enabled,
		),
		check(
			"dial_by_name_directory_search_field_check",
			sql`search_field in ('last-name', 'first-name', 'full-name')`,
		),
		destinationCheck("dial_by_name_directory", "timeout", true),
		tenantIsolationPolicy("dial_by_name_directory"),
	],
);
