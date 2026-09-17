import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns, namedDestinationColumns } from "./columns";

/**
 * Call flows — the day/night switch, and the lamp that says which way it is pointing.
 *
 * # What upstream's feature actually is
 *
 * FusionPBX's `v_call_flows` is a two-destination row with a `status` boolean, a dialable
 * `extension`, and a `feature_code` (`*28` + a per-flow suffix) that toggles the boolean. A BLF key
 * provisioned onto the receptionist's phone watches that code, and the lamp is lit when the flow is
 * in its alternate state. That is the whole of it, and the reason it exists is that a *time
 * condition cannot be overridden by a human*: the office closes early for a funeral, and somebody
 * has to be able to press a key.
 *
 * So this is deliberately not "a time condition with a manual mode". The two features are siblings
 * and both are in this wave: a time condition answers "what does the clock say", a call flow answers
 * "what did somebody decide". `time_condition.override` is the third case — the clock, overruled.
 *
 * # Why the mode is a COLUMN and not a KV entry the walker reads
 *
 * The tempting alternative is to keep {@link callFlow.mode} out of the compiled artifact entirely
 * and have the engine read it from a live-state bucket at walk time, so a flip costs no recompile.
 * The park-slot precedent says otherwise, and it is the right precedent because parking is the one
 * feature in this schema that already splits the two:
 *
 *  - a park LOT's slot range is configuration and is compiled into the artifact
 *    (`InternalMatchTable.parkSlots`);
 *  - a park SLOT's occupancy is live state and lives in a bucket, because it changes per call, is
 *    owned by whichever engine holds the leg, and has no meaning after the call ends.
 *
 * A call flow's mode is on the first side of that line and not the second. It is org configuration:
 * it changes a few times a day at most, it must survive every process in the fleet restarting, it is
 * something an administrator edits in a form as readily as a receptionist toggles from a handset,
 * and "what is this tenant's routing right now" must be answerable by reading the artifact alone —
 * which is what makes the compiled artifact a complete picture and what lets a call-flow inspector
 * explain a call without a second source of truth. A recompile per flip is the same cost as any
 * other configuration write, and this platform already recompiles on every one of those.
 *
 * The lamp is the part that IS live-state-shaped, and it goes where live state goes: flipping the
 * mode writes an entry into the `presence` KV bucket under the flow's own dialable code, which is
 * exactly the bucket `sipd` already serves SUBSCRIBEs from. No new bucket, no new event package —
 * a BLF key watching `*281` is watching a presence key like any other.
 */

/** Which destination trio a call flow is currently pointing at. */
export const CALL_FLOW_MODES = ["day", "night"] as const;

export type CallFlowMode = (typeof CALL_FLOW_MODES)[number];

export const callFlow = pgTable.withRLS(
	"call_flow",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/**
		 * Dialable number for the flow, when it has one. Nullable for the reason a paging group's is:
		 * a flow reachable only through its feature code has no number, and forcing one on it would
		 * make an administrator invent digits that then collide with an extension.
		 */
		extensionNumber: text("extension_number"),
		/**
		 * The star code that toggles the mode, and the key a BLF lamp watches.
		 *
		 * Upstream numbers these `*28` + a suffix per flow; that shape is seeded by the API rather
		 * than defaulted here, because the suffix is a per-row decision and a column default cannot
		 * make one. Nullable: a flow an administrator only ever flips from the admin UI needs no code,
		 * and a code that exists is a code somebody's phone can dial.
		 *
		 * NOT a `feature_code` row. Those are a closed catalogue of ACTIONS with a compiler-known
		 * argument mode; this is an instance-specific toggle whose whole meaning is "this row". The
		 * compiler screens the two against each other and refuses a collision rather than letting one
		 * silently shadow the other.
		 */
		featureCode: text("feature_code"),
		/** Where calls go in `day` mode — the ordinary, open-for-business destination. */
		...destinationColumns(),
		/** Where calls go in `night` mode. Required: a flow with one destination is not a flow. */
		...namedDestinationColumns("night"),
		/**
		 * The current mode. Persisted because it is org state, not instance state — see the header.
		 */
		mode: text("mode").$type<CallFlowMode>().notNull().default("day"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("call_flow_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("call_flow_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		uniqueIndex("call_flow_organization_feature_code_key")
			.on(table.organizationId, table.featureCode)
			.where(sql`feature_code is not null`),
		index("call_flow_organization_enabled_idx").on(table.organizationId, table.enabled),
		check("call_flow_mode_check", sql`mode in ('day', 'night')`),
		destinationCheck("call_flow"),
		// NOT optional: `namedDestinationColumns` is nullable at the column level because every other
		// secondary trio in this schema is a branch that may be unset, but a call flow whose night
		// destination is NULL is a switch with one position. The check is what makes the trio
		// mandatory without a second set of column builders.
		destinationCheck("call_flow", "night"),
		tenantIsolationPolicy("call_flow"),
	],
);
