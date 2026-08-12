import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { extension } from "./extensions-schema";

/**
 * Shared line appearance (SLA / BLA). One line — a shared number or a named key — that appears on
 * several handsets at once, each on a button of its own, and behaves as ONE line: when one desk
 * seizes it the others' lamps go busy, a call answered on one can be picked up on another, and a
 * call left on hold rings every appearance back if nobody retrieves it.
 *
 * # Why this is not a ring group
 *
 * A ring group and a shared line both fan a call out to several extensions, so it is tempting to
 * model the second as the first. They differ in the fact that matters: a ring group is a way to
 * REACH people, and once someone answers the group is done — the other legs are cancelled and the
 * group has no further identity. A shared line is a SHARED RESOURCE, and its whole point is what
 * happens AFTER the answer: the line stays a single seizable thing whose state every appearance can
 * see and act on. That state — who holds it, whether it is on hold, when it recalls — is the
 * feature, and a ring group has nowhere to put it. So the members here are `appearance`s, not
 * destinations, and the seizure they arbitrate lives in a KV claim the engine CAS-updates, not in
 * this table.
 *
 * # Why membership is a real table with a foreign key and an ordinal
 *
 * The same argument the paging group makes. An appearance must resolve to a REAL extension — the
 * engine originates a leg to it and the credential path tells that extension's device which button
 * to light — so a member pointing at a deleted extension is not cosmetic, it is a dark key an
 * operator believes is live. `on delete cascade` removes the appearance in the same transaction the
 * extension is deleted in. The `ordinal` is the APPEARANCE INDEX: the button position the phone
 * lights and the number sipd stamps into the `Call-Info` header, so it cannot be the loader's
 * `ORDER BY` — it is the administrator's decision and needs a column that survives a re-read.
 */

export const SHARED_LINE_STRATEGIES = ["simultaneous", "sequential"] as const;
export type SharedLineStrategy = (typeof SHARED_LINE_STRATEGIES)[number];

export const sharedLine = pgTable.withRLS(
	"shared_line",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/**
		 * Dialable number the shared line represents, when it has one. Nullable and partial-unique for
		 * the same reason a ring group's is: a line that is only a shared key across a boss and an
		 * assistant has no number of its own, and a line with no number must not be forced to invent
		 * one that then collides with an extension.
		 */
		extensionNumber: text("extension_number"),
		/**
		 * How the appearances are offered a call to the line's number. `simultaneous` lights and rings
		 * every appearance at once (the receptionist case); `sequential` walks them in ordinal order
		 * (the boss-then-assistant case). The per-appearance delay a `sequential` walk needs is the
		 * ordinal itself, so — unlike a ring group — there is no per-member delay column.
		 */
		strategy: text("strategy").$type<SharedLineStrategy>().notNull().default("simultaneous"),
		ringTimeoutSeconds: integer("ring_timeout_seconds").notNull().default(30),
		/**
		 * How long a call held on the shared line may sit before it recalls — rings every appearance
		 * back so the held caller is not forgotten on a line whose holder walked away. `0` disables
		 * recall (the line holds indefinitely, the FreeSWITCH default for a plain hold). Per line
		 * because a busy front desk wants a short leash and a boss's private line wants none.
		 */
		holdRecallTimeoutSeconds: integer("hold_recall_timeout_seconds").notNull().default(60),
		/**
		 * Whether an idle appearance may join a call already up on the line (the boss/admin "barge" —
		 * an assistant stepping into the boss's call). Off by default because a line that any appearance
		 * can silently join is a privacy surprise, not a default.
		 */
		bargeInEnabled: boolean("barge_in_enabled").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("shared_line_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("shared_line_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		index("shared_line_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("shared_line"),
	],
);

/**
 * One appearance — one extension's button on the shared line.
 *
 * Two unique indexes rather than one: `(line, extension)` stops one desk holding two buttons on the
 * same line (which would light two lamps for one seizure and make the "who is on the line" answer
 * ambiguous), and `(line, ordinal)` stops two appearances claiming the same button position — which
 * would put the appearance index back in the loader's hands, which is what the column exists to take
 * away, and would hand two phones the same `Call-Info` appearance index.
 */
export const sharedLineAppearance = pgTable.withRLS(
	"shared_line_appearance",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		sharedLineId: uuidEntityId("shared_line_id")
			.notNull()
			.references(() => sharedLine.id, { onDelete: "cascade" }),
		extensionId: uuidEntityId("extension_id")
			.notNull()
			.references(() => extension.id, { onDelete: "cascade" }),
		/** The appearance index: the phone's button position and the `Call-Info` appearance-index. */
		ordinal: integer("ordinal").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("shared_line_appearance_line_extension_key").on(
			table.organizationId,
			table.sharedLineId,
			table.extensionId,
		),
		uniqueIndex("shared_line_appearance_line_ordinal_key").on(
			table.organizationId,
			table.sharedLineId,
			table.ordinal,
		),
		index("shared_line_appearance_organization_line_idx").on(
			table.organizationId,
			table.sharedLineId,
		),
		tenantIsolationPolicy("shared_line_appearance"),
	],
);
