import { Inject, Injectable } from "@nestjs/common";
import { getActiveOrganizationId, hasPermission } from "@optimiq-voice/auth";
import { MissingPermissionException, NoActiveOrganizationException } from "./auth.errors";
import { AUTH_REPOSITORY } from "./auth.tokens";
import { resolveRolePermissions } from "./role-permissions";
import type { AuthRepository, OrganizationMemberSummary } from "./auth.repository";
import type { AppSession, Permission } from "@optimiq-voice/auth";

export interface ResolvedAccess {
	readonly organizationId: string | null;
	readonly role: string | null;
	readonly permissions: readonly Permission[];
}

export interface OrganizationView {
	readonly id: string;
	readonly name: string;
	readonly slug: string | null;
	readonly logo: string | null;
	readonly role: string;
	readonly createdAt: Date;
}

export interface SessionOverview {
	readonly user: {
		readonly id: string;
		readonly email: string;
		readonly name: string;
		readonly emailVerified: boolean;
		readonly image: string | null;
		readonly platformRole: string | null;
	};
	readonly session: {
		readonly id: string;
		readonly expiresAt: Date;
		readonly impersonated: boolean;
	};
	readonly activeOrganization: OrganizationView | null;
	readonly role: string | null;
	readonly permissions: readonly Permission[];
}

/**
 * Session-shaped reads over the better-auth tables.
 *
 * Transport-agnostic by construction: it takes an `AppSession`, never a request, a header or a
 * cookie. The controllers are the only adapters.
 */
@Injectable()
export class AuthService {
	constructor(@Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository) {}

	/** The membership role and effective permission set for the session's active organization. */
	async resolveAccess(session: AppSession): Promise<ResolvedAccess> {
		const organizationId = getActiveOrganizationId(session) ?? null;
		if (!organizationId) {
			return { organizationId: null, role: null, permissions: [] };
		}

		/*
		 * A role already on the session is authoritative and skips the membership lookup.
		 *
		 * This is not a cache — it is how a principal that has no `member` row is represented. An
		 * `x-api-key` caller is a TENANT principal (`references: "organization"`), so
		 * `auth-http.plugin.ts` stamps the role the key acts with when it synthesises the session
		 * and there is nothing in `member` to look up. Cookie and bearer sessions never carry it,
		 * so their path is unchanged.
		 */
		if (session.activeOrganizationRole) {
			return {
				organizationId,
				role: session.activeOrganizationRole,
				permissions: resolveRolePermissions(session.activeOrganizationRole),
			};
		}

		const membership = await this.repository.findMembership(session.user.id, organizationId);
		if (!membership) {
			return { organizationId, role: null, permissions: [] };
		}

		return {
			organizationId,
			role: membership.role,
			permissions: resolveRolePermissions(membership.role),
		};
	}

	async getSessionOverview(session: AppSession): Promise<SessionOverview> {
		const access = await this.resolveAccess(session);
		const organization = access.organizationId
			? await this.repository.findOrganizationById(access.organizationId)
			: null;

		return {
			user: {
				id: session.user.id,
				email: session.user.email,
				name: session.user.name,
				emailVerified: session.user.emailVerified,
				image: session.user.image ?? null,
				platformRole: session.user.role ?? null,
			},
			session: {
				id: session.session.id,
				expiresAt: session.session.expiresAt,
				impersonated: Boolean(session.session.impersonatedBy),
			},
			activeOrganization:
				organization && access.role
					? {
							id: organization.id,
							name: organization.name,
							slug: organization.slug,
							logo: organization.logo,
							role: access.role,
							createdAt: organization.createdAt,
						}
					: null,
			role: access.role,
			permissions: access.permissions,
		};
	}

	async listMyOrganizations(session: AppSession): Promise<readonly OrganizationView[]> {
		const organizations = await this.repository.listOrganizationsForUser(session.user.id);
		return organizations.map((organization) => ({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			role: organization.role,
			createdAt: organization.createdAt,
		}));
	}

	/**
	 * Members of an organization. Org-scoped, so `organizationId` is the first parameter and the
	 * caller's membership is re-verified here rather than inferred from the session claim.
	 */
	async listMembers(
		organizationId: string,
		session: AppSession,
		required: Permission,
	): Promise<readonly OrganizationMemberSummary[]> {
		const role = await this.resolveRoleIn(organizationId, session);
		if (!hasPermission(resolveRolePermissions(role), required)) {
			throw new MissingPermissionException([required]);
		}

		return await this.repository.listMembers(organizationId);
	}

	/**
	 * The caller's role in a **requested** organization — the cross-tenant gate.
	 *
	 * Deliberately not read from `session.activeOrganizationId`: an org-scoped route takes the
	 * organization from the path, so it has to be re-authorized rather than assumed. Two principal
	 * kinds, one rule ("prove you belong to the organization you asked for"):
	 *
	 * - **user principals** (cookie, bearer) — re-read the `member` row, so a member removed from
	 *   an organization loses access on the very next request rather than at session refresh;
	 * - **tenant principals** (`x-api-key`) — there is no `member` row to read. The tenant comes
	 *   from the key's `referenceId`, which the caller cannot influence, so the check is that the
	 *   requested organization IS that one.
	 */
	private async resolveRoleIn(organizationId: string, session: AppSession): Promise<string> {
		const requested = organizationId.trim();
		if (requested.length === 0) {
			throw new NoActiveOrganizationException();
		}

		if (session.activeOrganizationRole) {
			if (getActiveOrganizationId(session) !== requested) {
				throw new NoActiveOrganizationException();
			}
			return session.activeOrganizationRole;
		}

		const membership = await this.repository.findMembership(session.user.id, requested);
		if (!membership) {
			throw new NoActiveOrganizationException();
		}
		return membership.role;
	}
}
