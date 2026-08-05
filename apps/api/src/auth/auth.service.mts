import { Inject, Injectable } from "@nestjs/common";
import { getActiveOrganizationId, hasPermission } from "@optimiq-voice/auth";
import { MissingPermissionException, NoActiveOrganizationException } from "./auth.errors.mjs";
import { AUTH_REPOSITORY } from "./auth.tokens.mjs";
import { resolveRolePermissions } from "./role-permissions.mjs";
import type { AuthRepository, OrganizationMemberSummary } from "./auth.repository.mjs";
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
		if (organizationId.trim().length === 0) {
			throw new NoActiveOrganizationException();
		}

		const membership = await this.repository.findMembership(session.user.id, organizationId);
		if (!membership) {
			throw new NoActiveOrganizationException();
		}
		if (!hasPermission(resolveRolePermissions(membership.role), required)) {
			throw new MissingPermissionException([required]);
		}

		return await this.repository.listMembers(organizationId);
	}
}
