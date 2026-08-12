import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * PIN numbers — outbound authorisation codes.
 *
 * A set of PINs is attached to an outbound route (`outbound_route.pin_set_id`); a call that matches
 * that route is challenged before a single trunk is dialled, and a caller who cannot answer the
 * challenge hears an announcement and is released. Upstream calls the feature "PIN numbers" and
 * uses it for exactly one thing: making somebody type a code before the tenant is billed for an
 * international minute.
 *
 * # Why the PINs are hashed and upstream's were not
 *
 * `v_pin_numbers.pin_number` is plaintext, and it is plaintext for an understandable reason —
 * FreeSWITCH's `pin` Lua script compares strings, and the accounting report has to be able to print
 * which code was used. Both of those are solved differently here and neither needs the secret back.
 *
 * A PIN is a bearer credential for SPENDING MONEY. It is short (four to eight digits), it is shared
 * across a department, it is written on a sticky note, and it is the one credential in this schema
 * whose compromise has an immediate cash value to the attacker. A plaintext column means every
 * database backup, every read replica, every support engineer with a `SELECT` and every artifact
 * cached in a KV bucket carries a live key to the tenant's trunks. So the column is a digest in the
 * `VOICEMAIL_PIN_HASH` format `packages/routing/src/voicemail-pin.ts` defines — the same format,
 * the same parser and the same constant-time verifier already used for mailbox and conference PINs,
 * because a second PIN format would be a second thing to get wrong.
 *
 * The cost is real and worth naming: an administrator can no longer be shown the PIN they set. That
 * is the same trade the mailbox PIN already makes, the admin UI already says "set a new PIN"
 * everywhere it appears, and the alternative is a column that turns one leaked backup into a phone
 * bill.
 *
 * # What the CDR records, and what it must not
 *
 * The CDR records {@link pinSetEntry.ordinal} and {@link pinSetEntry.label} — "entry 3, the night
 * desk" — and never the digits. That is what upstream's report actually needed (which of our codes
 * placed this call), and it is answerable without the secret because the entry has an identity of
 * its own. Storing the PIN on a CDR row would put the credential in the one table nobody ever
 * expects to be sensitive and everybody exports.
 */

export const pinSet = pgTable.withRLS(
	"pin_set",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		description: text("description"),
		/**
		 * The prompt asking for the code. Nullable, and deliberately not a foreign key to `prompt`:
		 * a set with no prompt gets the engine's deployment-wide "enter your authorisation code"
		 * announcement, which is what every tenant that has never recorded one wants. Carried as a
		 * prompt id when set, resolved by the compiler like every other prompt reference — including
		 * a phrase, since a phrase IS a `prompt` row.
		 */
		promptId: uuidEntityId("prompt_id"),
		/** Played when every attempt has failed, before the call is released. */
		failurePromptId: uuidEntityId("failure_prompt_id"),
		/**
		 * How many tries a caller gets. Three is the universal telephone answer and the reason is not
		 * arbitrary: a four-digit PIN behind unbounded retries is a keypad away from being brute
		 * forced during one long call, and each attempt costs the attacker nothing.
		 */
		maxAttempts: integer("max_attempts").notNull().default(3),
		/** How long the caller has to finish entering digits, per attempt. */
		digitTimeoutMs: integer("digit_timeout_ms").notNull().default(8000),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("pin_set_organization_name_key").on(table.organizationId, table.name),
		index("pin_set_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("pin_set"),
	],
);

/**
 * One authorisation code in a set.
 *
 * `ordinal` is the stable identity a CDR names, and it is why an entry is a row rather than an
 * element of a `text[]` on the set: an array position shifts when somebody deletes the second code,
 * and every historical CDR that said "code 3" would silently start meaning a different code. A row
 * with an id and an ordinal that the reorder endpoint rewrites wholesale does not have that
 * problem, because the CDR stores the ORDINAL AT THE TIME and the entry it named still exists to be
 * looked up by id.
 *
 * There is no `enabled = false` shortcut to "this code is retired but keep the history": disabling
 * is exactly that, and it is why the column is here rather than expecting a delete.
 */
export const pinSetEntry = pgTable.withRLS(
	"pin_set_entry",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		pinSetId: uuidEntityId("pin_set_id")
			.notNull()
			.references(() => pinSet.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		/** Who the code belongs to, for the CDR and the admin list. Never the code itself. */
		label: text("label"),
		/**
		 * Digest of the PIN, in the `VOICEMAIL_PIN_HASH` format. Never a PIN.
		 *
		 * Written only by the API's dedicated set-PIN path, never readable through any DTO — the
		 * column is on `PbxResource.secretColumns` for the same reason `voicemail_box.pin_hash` is.
		 */
		pinHash: text("pin_hash").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("pin_set_entry_set_ordinal_key").on(
			table.organizationId,
			table.pinSetId,
			table.ordinal,
		),
		index("pin_set_entry_organization_set_idx").on(table.organizationId, table.pinSetId),
		tenantIsolationPolicy("pin_set_entry"),
	],
);
