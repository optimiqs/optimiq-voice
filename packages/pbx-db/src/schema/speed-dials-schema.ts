import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns } from "./columns";

/**
 * Organization speed dials — short codes every handset in the tenant can dial.
 *
 * # This is the SERVER half of a feature that already half-exists
 *
 * `DEVICE_KEY_TYPES` already has `speed-dial`, and all five vendor templates render it: that is the
 * per-DEVICE speed dial, a label and a number burned into one phone's key by provisioning. It stays
 * exactly as it is and this does not replace it — a key on somebody's own phone is their own
 * business, and it costs the dial plan nothing.
 *
 * What is missing, and what upstream has, is the SHARED one: a code every phone in the tenant can
 * dial regardless of who provisioned it, edited in one place, dialable from a softphone that has no
 * keys at all. `feature-codes.ts` carries a comment acknowledging the gap. This closes it.
 *
 * # Where a code sits in the internal match order, and why it is its own table there
 *
 * The compiled artifact consults, in order: emergency numbers, feature codes, voicemail prefixes,
 * **speed dials**, exact internal numbers, park slots.
 *
 * After feature codes, because a feature code must always win. `*0` is seeded as eavesdrop and takes
 * a required argument, so a speed dial numbered `*01` would otherwise be swallowed as "eavesdrop on
 * extension 1" — a collision with no runtime symptom beyond the wrong thing happening. Putting speed
 * dials second and raising a compile-time diagnostic on the overlap means the tenant is told at save
 * time instead of discovering it on a call.
 *
 * Before exact internal numbers, so a numeric code is reachable — and the compiler additionally
 * claims numeric codes through the same duplicate-number check every dialable entity goes through,
 * so a speed dial numbered `200` collides LOUDLY with extension 200 rather than shadowing it.
 *
 * It is a table of its own in the artifact rather than an entry in `numbers` because the codes are
 * not all numbers: `*01` cannot live in a map that is consulted after feature codes have already
 * had their chance at anything beginning with a star.
 *
 * # Why the target is a destination trio and not a number
 *
 * The obvious modelling is `{ code, number }` — that is what a phone's own speed-dial key is. It is
 * the wrong shape for a server-side one for the same reason a bridge is: a bare number would have to
 * be dialled by something, and "dial this string" with no route matched is the toll-fraud primitive
 * `aliases-schema.ts` argues against at length. A trio means a speed dial to an outside number goes
 * out through outbound routing with the caller's own toll class applied, and a speed dial to a
 * colleague is an `extension` destination that never touches a trunk.
 */
export const speedDial = pgTable.withRLS(
	"speed_dial",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/**
		 * The dialed code. Star-prefixed (`*01`) or bare digits (`8001`); the compiler validates the
		 * shape and screens both forms against the feature-code table and the internal numbers.
		 */
		code: text("code").notNull(),
		label: text("label").notNull(),
		/** Where the code goes. Required — a speed dial with no target is a code that does nothing. */
		...destinationColumns(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("speed_dial_organization_code_key").on(table.organizationId, table.code),
		index("speed_dial_organization_enabled_idx").on(table.organizationId, table.enabled),
		destinationCheck("speed_dial"),
		tenantIsolationPolicy("speed_dial"),
	],
);
