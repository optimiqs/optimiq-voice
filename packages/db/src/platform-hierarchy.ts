import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { member } from "./schema/auth/organization-schema";
import { organization } from "./schema/auth/organization-schema";
import { organizationHierarchy } from "./schema/platform/organization-platform-schema";
import type { AdminDatabase } from "./client";

/**
 * Reads and writes over the reseller hierarchy — the base-database repository W14 owns.
 *
 * These live in `@optimiq-voice/db` rather than in `apps/api` for the reason
 * `apps/api/src/auth/auth.repository.ts` states about the better-auth tables: `apps/api` pins an
 * older Drizzle than `@optimiq-voice/db`, so a query BUILT there against a 1.0-rc table object
 * would apply the wrong operators. The queries are therefore built here, with this package's own
 * Drizzle, and `apps/api` calls them with the untenanted `adminDb` handle it already owns.
 */

export interface HierarchyRow {
	readonly organizationId: string;
	readonly parentOrganizationId: string | null;
	readonly isReseller: boolean;
	readonly suspendedAt: Date | null;
}

export interface ChildOrganizationRow {
	readonly organizationId: string;
	readonly name: string;
	readonly slug: string;
	readonly createdAt: Date;
	readonly suspendedAt: Date | null;
	readonly isReseller: boolean;
	readonly memberCount: number;
}

function toHierarchyRow(row: {
	organizationId: string;
	parentOrganizationId: string | null;
	isReseller: boolean;
	suspendedAt: Date | null;
}): HierarchyRow {
	return {
		organizationId: row.organizationId,
		parentOrganizationId: row.parentOrganizationId,
		isReseller: row.isReseller,
		suspendedAt: row.suspendedAt,
	};
}

/** The hierarchy row for one organization, or `null` when it has never been placed. */
export async function readHierarchy(
	db: AdminDatabase,
	organizationId: string,
): Promise<HierarchyRow | null> {
	const rows = await db
		.select({
			organizationId: organizationHierarchy.organizationId,
			parentOrganizationId: organizationHierarchy.parentOrganizationId,
			isReseller: organizationHierarchy.isReseller,
			suspendedAt: organizationHierarchy.suspendedAt,
		})
		.from(organizationHierarchy)
		.where(eq(organizationHierarchy.organizationId, organizationId))
		.limit(1);
	const row = rows[0];
	return row ? toHierarchyRow(row) : null;
}

/**
 * The children a reseller administers, with their org identity and a cheap usage figure
 * (member count). Richer telephony usage aggregation is a documented seam — it would sum the
 * per-child `org_limits` usage the limits feature already accounts, across the PBX database.
 */
export async function listChildOrganizations(
	db: AdminDatabase,
	parentOrganizationId: string,
): Promise<readonly ChildOrganizationRow[]> {
	const rows = await db
		.select({
			organizationId: organizationHierarchy.organizationId,
			suspendedAt: organizationHierarchy.suspendedAt,
			isReseller: organizationHierarchy.isReseller,
			name: organization.name,
			slug: organization.slug,
			createdAt: organization.createdAt,
		})
		.from(organizationHierarchy)
		.innerJoin(organization, eq(organization.id, organizationHierarchy.organizationId))
		.where(eq(organizationHierarchy.parentOrganizationId, parentOrganizationId));

	if (rows.length === 0) {
		return [];
	}

	const counts = await db
		.select({ organizationId: member.organizationId, userId: member.userId })
		.from(member)
		.where(
			inArray(
				member.organizationId,
				rows.map((row) => row.organizationId),
			),
		);
	const countByOrg = new Map<string, number>();
	for (const row of counts) {
		countByOrg.set(row.organizationId, (countByOrg.get(row.organizationId) ?? 0) + 1);
	}

	return rows.map((row) => ({
		organizationId: row.organizationId,
		name: row.name,
		slug: row.slug,
		createdAt: row.createdAt,
		suspendedAt: row.suspendedAt,
		isReseller: row.isReseller,
		memberCount: countByOrg.get(row.organizationId) ?? 0,
	}));
}

/** Every organization the platform has flagged as a reseller. */
export async function listResellerOrganizationIds(db: AdminDatabase): Promise<readonly string[]> {
	const rows = await db
		.select({ organizationId: organizationHierarchy.organizationId })
		.from(organizationHierarchy)
		.where(eq(organizationHierarchy.isReseller, true));
	return rows.map((row) => row.organizationId);
}

/** Upsert the hierarchy row for an organization, patching only the fields supplied. */
export async function upsertHierarchy(
	db: AdminDatabase,
	input: {
		readonly organizationId: string;
		readonly parentOrganizationId?: string | null;
		readonly isReseller?: boolean;
		readonly suspendedAt?: Date | null;
	},
): Promise<HierarchyRow> {
	const insertValues = {
		organizationId: input.organizationId,
		parentOrganizationId: input.parentOrganizationId ?? null,
		isReseller: input.isReseller ?? false,
		suspendedAt: input.suspendedAt ?? null,
	};
	const updateValues: Record<string, unknown> = {};
	if (input.parentOrganizationId !== undefined) {
		updateValues.parentOrganizationId = input.parentOrganizationId;
	}
	if (input.isReseller !== undefined) {
		updateValues.isReseller = input.isReseller;
	}
	if (input.suspendedAt !== undefined) {
		updateValues.suspendedAt = input.suspendedAt;
	}

	const rows = await db
		.insert(organizationHierarchy)
		.values(insertValues)
		.onConflictDoUpdate({
			target: organizationHierarchy.organizationId,
			set:
				Object.keys(updateValues).length > 0
					? updateValues
					: { organizationId: input.organizationId },
		})
		.returning({
			organizationId: organizationHierarchy.organizationId,
			parentOrganizationId: organizationHierarchy.parentOrganizationId,
			isReseller: organizationHierarchy.isReseller,
			suspendedAt: organizationHierarchy.suspendedAt,
		});
	return toHierarchyRow(rows[0]!);
}

/** Suspend or reinstate a child. */
export async function setChildSuspended(
	db: AdminDatabase,
	organizationId: string,
	suspended: boolean,
): Promise<void> {
	await db
		.update(organizationHierarchy)
		.set({ suspendedAt: suspended ? new Date() : null })
		.where(eq(organizationHierarchy.organizationId, organizationId));
}

/**
 * Create a child organization and link it under a reseller in one step.
 *
 * The `organization` row is inserted directly rather than through better-auth's create-org flow:
 * a reseller-provisioned tenant has no human creator to seat as its owner, so there is no member
 * to create and none of better-auth's create hooks apply. Seating an initial owner (an invitation
 * to the tenant's first admin) is a deliberate follow-up seam — the reseller administers the child
 * cross-tenant until then.
 */
export async function createChildOrganization(
	db: AdminDatabase,
	input: { readonly parentOrganizationId: string; readonly name: string; readonly slug: string },
): Promise<{
	readonly id: string;
	readonly name: string;
	readonly slug: string;
	readonly createdAt: Date;
}> {
	return await db.transaction(async (tx) => {
		const inserted = await tx
			.insert(organization)
			.values({ name: input.name, slug: input.slug })
			.returning({
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				createdAt: organization.createdAt,
			});
		const created = inserted[0]!;
		await tx.insert(organizationHierarchy).values({
			organizationId: created.id,
			parentOrganizationId: input.parentOrganizationId,
			isReseller: false,
			suspendedAt: null,
		});
		return created;
	});
}

/** True when the organization has at least one reseller child (used to guard deletion elsewhere). */
export async function hasChildren(
	db: AdminDatabase,
	parentOrganizationId: string,
): Promise<boolean> {
	const rows = await db
		.select({ organizationId: organizationHierarchy.organizationId })
		.from(organizationHierarchy)
		.where(
			and(
				eq(organizationHierarchy.parentOrganizationId, parentOrganizationId),
				isNotNull(organizationHierarchy.organizationId),
			),
		)
		.limit(1);
	return rows.length > 0;
}
