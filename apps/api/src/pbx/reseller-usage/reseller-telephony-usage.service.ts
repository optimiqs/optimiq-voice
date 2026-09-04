import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { listChildOrganizations, readHierarchy } from "@optimiq-voice/db";
import { count, extension, inArray, phoneNumber, trunk } from "@optimiq-voice/pbx-db";
import { AUTH_PLATFORM } from "../../auth/auth.tokens";
import { NotAResellerException } from "../../auth/reseller/reseller.errors";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import type { AuthPlatform } from "../../auth/auth.platform";
import type { AppSession } from "@optimiq-voice/auth";
import type { AdminDatabase } from "@optimiq-voice/db";
import type { PbxDatabaseClient, PgTable } from "@optimiq-voice/pbx-db";

/**
 * The reseller's telephony usage roll-up — the "richer aggregation" seam
 * `packages/db/src/platform-hierarchy.ts` and `reseller.service.ts` both name.
 *
 * ## Why it lives here and not beside the rest of the reseller surface
 *
 * The other reseller endpoints (`apps/api/src/auth/reseller`) read the BASE database only — the
 * hierarchy, the org rows, the member counts — so they live in the auth slice with the `adminDb`
 * handle. Telephony usage is different in the way that decides the module boundary: it sums
 * `extension`, `trunk` and `phone_number` rows, which live in the PBX database. That handle
 * (`PBX_DATABASE`) is owned by `PbxModule`, and the auth slice cannot take it without importing
 * `PbxModule`, which imports the auth slice back — a cycle. `PbxModule` already imports the auth
 * slice, so THIS is the side of the boundary where both handles are reachable: `AUTH_PLATFORM` for
 * the hierarchy (which children, are they mine, are they suspended) and `PBX_DATABASE` for the
 * counts. The route still answers under `/api/v1/reseller`.
 *
 * ## The two gates, unchanged
 *
 * Same as every reseller call: the controller's `@RequirePermissions("reseller.read")` proves the
 * grant, and {@link ensureReseller} proves the acting org carries the platform `is_reseller` flag.
 * The children summed are exactly those whose `parent_organization_id` is the acting reseller —
 * resolved from the hierarchy, never from the client — so the cross-tenant read over the untenanted
 * PBX `adminDb` only ever reaches rows the reseller administers.
 */
@Injectable()
export class ResellerTelephonyUsageService {
	constructor(
		@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform,
		@Inject(PBX_DATABASE) private readonly pbx: PbxDatabaseClient,
	) {}

	private get baseDb(): AdminDatabase {
		return this.platform.database.adminDb;
	}

	async usage(session: AppSession): Promise<ResellerTelephonyUsageView> {
		const organizationId = requireActiveOrganizationId(session);
		const hierarchy = await readHierarchy(this.baseDb, organizationId);
		if (!hierarchy?.isReseller) {
			throw new NotAResellerException();
		}

		const children = await listChildOrganizations(this.baseDb, organizationId);
		const childIds = children.map((child) => child.organizationId);

		const [extensions, trunks, numbers] = await Promise.all([
			this.countByOrganization(extension, extension.organizationId, childIds),
			this.countByOrganization(trunk, trunk.organizationId, childIds),
			this.countByOrganization(phoneNumber, phoneNumber.organizationId, childIds),
		]);

		const perChild = children.map((child) => ({
			organizationId: child.organizationId,
			name: child.name,
			slug: child.slug,
			suspended: child.suspendedAt !== null,
			memberCount: child.memberCount,
			extensions: extensions.get(child.organizationId) ?? 0,
			trunks: trunks.get(child.organizationId) ?? 0,
			numbers: numbers.get(child.organizationId) ?? 0,
		}));

		return {
			childCount: children.length,
			totals: {
				extensions: sumOf(perChild, "extensions"),
				trunks: sumOf(perChild, "trunks"),
				numbers: sumOf(perChild, "numbers"),
				members: perChild.reduce((total, child) => total + child.memberCount, 0),
			},
			children: perChild,
		};
	}

	/**
	 * `count(*) grouped by organization_id`, over the untenanted PBX handle.
	 *
	 * `adminDb` and not `withTenantScope` because the whole point is a CROSS-tenant sum, and the
	 * `where organization_id in (…)` is restricted to the reseller's own children, resolved above — so
	 * bypassing RLS reads only rows the reseller administers. An empty child set never queries.
	 */
	private async countByOrganization(
		table: PgTable,
		organizationColumn: OrganizationColumn,
		organizationIds: readonly string[],
	): Promise<ReadonlyMap<string, number>> {
		if (organizationIds.length === 0) {
			return new Map<string, number>();
		}
		const rows = await this.pbx.adminDb
			.select({ organizationId: organizationColumn, total: count() })
			.from(table)
			.where(inArray(organizationColumn, [...organizationIds]))
			.groupBy(organizationColumn);
		const counts = new Map<string, number>();
		for (const row of rows) {
			counts.set(row.organizationId, row.total);
		}
		return counts;
	}
}

/**
 * The `organization_id` column of one of the three tenant tables summed here.
 *
 * Drizzle bakes the table name into a column's type, so the three are distinct types even though
 * `tenantOrganizationIdColumn` declares them identically — a union names all three and keeps
 * `select`/`groupBy`/`inArray` happy without hand-writing Drizzle's column generics.
 */
type OrganizationColumn =
	| typeof extension.organizationId
	| typeof trunk.organizationId
	| typeof phoneNumber.organizationId;

function sumOf(
	children: readonly {
		readonly extensions: number;
		readonly trunks: number;
		readonly numbers: number;
	}[],
	key: "extensions" | "trunks" | "numbers",
): number {
	return children.reduce((total, child) => total + child[key], 0);
}

export interface ResellerChildTelephonyUsage {
	readonly organizationId: string;
	readonly name: string;
	readonly slug: string;
	readonly suspended: boolean;
	readonly memberCount: number;
	readonly extensions: number;
	readonly trunks: number;
	readonly numbers: number;
}

export interface ResellerTelephonyUsageView {
	readonly childCount: number;
	readonly totals: {
		readonly extensions: number;
		readonly trunks: number;
		readonly numbers: number;
		readonly members: number;
	};
	readonly children: readonly ResellerChildTelephonyUsage[];
}
