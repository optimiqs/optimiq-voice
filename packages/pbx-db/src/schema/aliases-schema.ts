import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns } from "./columns";

/**
 * Destination aliases — FusionPBX's "Bridges", with the escape hatch removed.
 *
 * # What upstream's bridge is
 *
 * `v_bridges` is `{ name, destination }` where `destination` is a raw FreeSWITCH DIAL STRING:
 * `sofia/gateway/carrier-a/$1`, `user/1001@domain`, `loopback/…`. Anywhere a dialplan action wants a
 * bridge target it can write `${bridge_name}` and the string is substituted verbatim. It is used for
 * exactly one legitimate purpose — naming a target once so that moving it is one edit rather than
 * twenty — and it is spelled in a way that also does something else entirely.
 *
 * # Why ours is not a string
 *
 * A raw dial string is a way past every gate this platform has. `sofia/gateway/x/+1900…` reaches a
 * carrier with no outbound route matched, no toll class checked, no call-block rule consulted and no
 * caller-id policy applied — which is to say it is a toll-fraud primitive with a friendly name. The
 * routing artifact's whole design is that a call reaches a trunk by resolving through
 * `OutboundMatchTable`; a feature whose purpose is to bypass that is not a feature this platform can
 * have, however convenient the twenty-edits-to-one part is.
 *
 * So an alias names a DESTINATION TRIO — the same trio every other pointer in this schema uses — and
 * the twenty-edits-to-one benefit survives intact while the bypass does not. An alias pointing at an
 * external number still goes out through outbound routing, because that is what the `external`
 * destination type means everywhere else.
 *
 * # Why it is a macro and not a plan node
 *
 * The compiler expands an alias FLAT: `alias:<id>` resolves to whatever its target resolved to, and
 * no `alias` node ever appears in the artifact. An alias is an editing convenience, not a step in a
 * call — a caller who reaches one should reach the target, not "the alias, which then goes to the
 * target". Compiling it flat means the artifact and the call-flow inspector show the real
 * destination, the engine gains no node kind it has to learn, and an alias costs nothing at call
 * time.
 *
 * The one thing flatness demands is a cycle guard, because an alias may point at another alias and a
 * pair pointing at each other would expand forever. The compiler bounds the chain and reports the
 * loop rather than following it.
 */
export const destinationAlias = pgTable.withRLS(
	"destination_alias",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		description: text("description"),
		/** What the alias stands for. Required — an alias with no target is a name and nothing else. */
		...destinationColumns(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("destination_alias_organization_name_key").on(table.organizationId, table.name),
		index("destination_alias_organization_enabled_idx").on(table.organizationId, table.enabled),
		destinationCheck("destination_alias"),
		tenantIsolationPolicy("destination_alias"),
	],
);
