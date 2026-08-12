import { index, integer, pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * Per-organization limits — upstream's "domain limits", which the inventory names as the seam that
 * becomes SaaS metering.
 *
 * # One row per organization, and every column nullable
 *
 * NULL means "no limit", and it is the default because it has to be: this table arrives after
 * tenants exist, and a column with a number in it would silently cap every organization already
 * running. A tenant with no row at all is unlimited too — the enforcement path reads the row and
 * treats its absence as an empty set of limits, so creating the row is what starts the metering
 * rather than what the metering depends on.
 *
 * # Who may edit it, and why the answer is uncomfortable
 *
 * This is a PLATFORM-OPERATOR surface wearing tenant clothes. A limit an administrator can raise is
 * not a limit, and every other row in this database is one the tenant owns outright. The honest
 * model is the reseller hierarchy — a parent organization sets its children's caps — and that is
 * `parent_uuid` in the FusionPBX inventory, row 4.43 in the parity audit, and W14 in this plan. It
 * does not exist yet.
 *
 * So the interim is stated rather than smuggled: the row is tenant-scoped like everything else, RLS
 * keeps one tenant out of another's, and the WRITE is gated on a permission held by `owner` alone
 * (`org-limits.write`) while the read is available to administrators so the usage screen renders.
 * That is not a real control-plane boundary — an owner can raise their own cap — and it is not
 * pretending to be one. What it buys is that the columns, the enforcement and the usage accounting
 * exist and are tested, so W14 moves a permission and a controller rather than building the feature.
 *
 * # `maxConcurrentCalls` is the one that was already half-wired
 *
 * `trunk.max_channels` exists and is compiled into every `TrunkAttempt`; this is the ORG-wide
 * equivalent, and it counts differently on purpose. A trunk cap is about what one carrier will
 * accept. An organization cap is about what the tenant has bought, and it has to count internal
 * calls, conference legs and queue callers too — none of which touch a trunk.
 */
export const orgLimit = pgTable.withRLS(
	"org_limit",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Refused at extension create with a 4xx naming this limit. NULL is unlimited. */
		maxExtensions: integer("max_extensions"),
		/** Same, for trunks. */
		maxTrunks: integer("max_trunks"),
		/**
		 * Simultaneous live channels across the whole organization, enforced by the engine.
		 *
		 * Enforced at ADMISSION rather than at create, which is what makes it different in kind from
		 * the two above: there is no row to refuse, there is a call to refuse, and refusing it late is
		 * a caller hearing congestion instead of an administrator seeing an error message.
		 */
		maxConcurrentCalls: integer("max_concurrent_calls"),
		/**
		 * Stored audio, in megabytes: recordings, voicemail messages and the media library together.
		 *
		 * Megabytes rather than bytes because the number a plan is sold in is megabytes, and an
		 * integer column in bytes runs out at two gigabytes — which is a small tenant. The usage side
		 * reports bytes and divides, so the comparison never loses precision in the direction that
		 * would let a tenant over-run.
		 */
		maxStorageMb: integer("max_storage_mb"),
		...auditTimestampColumns(),
	},
	(table) => [
		// One row per organization. A unique index rather than making `organization_id` the primary
		// key, because every table in this schema has a `uuid` `id` and the RLS preflight asserts it.
		uniqueIndex("org_limit_organization_key").on(table.organizationId),
		index("org_limit_organization_idx").on(table.organizationId),
		tenantIsolationPolicy("org_limit"),
	],
);
