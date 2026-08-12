import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	type ChildOrganizationRow,
	createChildOrganization,
	type HierarchyRow,
	listChildOrganizations,
	readHierarchy,
	setChildSuspended,
} from "@optimiq-voice/db";
import { AUTH_PLATFORM } from "../auth.tokens";
import { type CreateChildInput, deriveSlug } from "./reseller.dto";
import { NotAResellerException, NotYourChildException } from "./reseller.errors";
import type { AuthPlatform } from "../auth.platform";
import type { AppSession } from "@optimiq-voice/auth";

export interface ChildOrganizationView {
	readonly organizationId: string;
	readonly name: string;
	readonly slug: string;
	readonly createdAt: Date;
	readonly suspended: boolean;
	readonly isReseller: boolean;
	readonly memberCount: number;
}

export interface ResellerUsageView {
	readonly childCount: number;
	readonly suspendedCount: number;
	readonly memberCount: number;
}

function toView(row: ChildOrganizationRow): ChildOrganizationView {
	return {
		organizationId: row.organizationId,
		name: row.name,
		slug: row.slug,
		createdAt: row.createdAt,
		suspended: row.suspendedAt !== null,
		isReseller: row.isReseller,
		memberCount: row.memberCount,
	};
}

/**
 * Fail unless `child` is administered by `resellerOrganizationId`. Exported and pure so the row
 * check is unit-tested apart from the database, exactly the `assertMayAct` precedent
 * (`queue-agent-session.service.ts`): the guard proves the caller HOLDS `reseller.write`; this
 * proves the ROW is theirs.
 */
export function assertChildOfReseller(
	resellerOrganizationId: string,
	child: HierarchyRow | null,
): void {
	if (!child || child.parentOrganizationId !== resellerOrganizationId) {
		throw new NotYourChildException();
	}
}

/**
 * The reseller (parent-tenant) surface.
 *
 * Two gates on every call, in this order: the controller's `@RequirePermissions("reseller.*")`
 * proves the acting member holds the grant, and {@link requireResellerOrganizationId} proves the
 * session's own organization carries the platform `is_reseller` flag. Both are required — the model
 * decision recorded at the `reseller.*` registry entry. All reads and writes run on the untenanted
 * base-database handle (`adminDb`), because the reseller crosses the RLS boundary by definition, and
 * row reach is narrowed by {@link assertChildOfReseller}.
 */
@Injectable()
export class ResellerService {
	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {}

	private get adminDb() {
		return this.platform.database.adminDb;
	}

	/** The acting reseller's organization id, after confirming the `is_reseller` capability. */
	private async requireResellerOrganizationId(session: AppSession): Promise<string> {
		const organizationId = requireActiveOrganizationId(session);
		const hierarchy = await readHierarchy(this.adminDb, organizationId);
		if (!hierarchy?.isReseller) {
			throw new NotAResellerException();
		}
		return organizationId;
	}

	async listChildren(session: AppSession): Promise<readonly ChildOrganizationView[]> {
		const organizationId = await this.requireResellerOrganizationId(session);
		const rows = await listChildOrganizations(this.adminDb, organizationId);
		return rows.map(toView);
	}

	async usage(session: AppSession): Promise<ResellerUsageView> {
		const organizationId = await this.requireResellerOrganizationId(session);
		const rows = await listChildOrganizations(this.adminDb, organizationId);
		return {
			childCount: rows.length,
			suspendedCount: rows.filter((row) => row.suspendedAt !== null).length,
			memberCount: rows.reduce((total, row) => total + row.memberCount, 0),
		};
	}

	async createChild(session: AppSession, input: CreateChildInput): Promise<ChildOrganizationView> {
		const organizationId = await this.requireResellerOrganizationId(session);
		const created = await createChildOrganization(this.adminDb, {
			parentOrganizationId: organizationId,
			name: input.name,
			slug: input.slug ?? deriveSlug(input.name),
		});
		return {
			organizationId: created.id,
			name: created.name,
			slug: created.slug,
			createdAt: created.createdAt,
			suspended: false,
			isReseller: false,
			memberCount: 0,
		};
	}

	async setSuspended(
		session: AppSession,
		childOrganizationId: string,
		suspended: boolean,
	): Promise<{ readonly organizationId: string; readonly suspended: boolean }> {
		const organizationId = await this.requireResellerOrganizationId(session);
		const child = await readHierarchy(this.adminDb, childOrganizationId);
		assertChildOfReseller(organizationId, child);
		await setChildSuspended(this.adminDb, childOrganizationId, suspended);
		return { organizationId: childOrganizationId, suspended };
	}
}
