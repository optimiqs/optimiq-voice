import type { Permission } from "./permissions";

/**
 * Session helpers.
 *
 * `activeOrganizationId` is the tenant claim: it selects the row-level-security scope every
 * org-scoped repository runs under. Code that touches tenant data must obtain it through
 * {@link requireActiveOrganizationId} so a session without an organization fails loudly at the
 * boundary instead of silently querying an unscoped transaction.
 */

export interface AppSessionUser {
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly emailVerified: boolean;
	readonly image?: string | null;
	/** Platform-level role from the admin plugin — NOT the organization membership role. */
	readonly role?: string | null;
	readonly banned?: boolean | null;
	readonly twoFactorEnabled?: boolean | null;
}

export interface AppSessionRecord {
	readonly id: string;
	readonly userId: string;
	readonly token: string;
	readonly expiresAt: Date;
	readonly activeOrganizationId?: string | null;
	readonly impersonatedBy?: string | null;
	readonly ipAddress?: string | null;
	readonly userAgent?: string | null;
}

/** What `auth.api.getSession()` yields once our hooks have run. */
export interface AppSession {
	readonly session: AppSessionRecord;
	readonly user: AppSessionUser;
	/** Membership role in the active organization, resolved by the org-context hook. */
	readonly activeOrganizationRole?: string | null;
	/** Effective permission set for the active organization. */
	readonly permissions?: readonly Permission[];
}

/** Raised when tenant-scoped work is attempted with no organization selected on the session. */
export class MissingActiveOrganizationError extends Error {
	readonly _tag = "MissingActiveOrganizationError" as const;
	readonly userId: string | undefined;

	constructor(userId?: string) {
		super(
			"The session has no active organization. Select an organization before performing tenant-scoped work.",
		);
		this.name = "MissingActiveOrganizationError";
		this.userId = userId;
	}
}

/** Raised when a session is required but absent or expired. */
export class UnauthenticatedSessionError extends Error {
	readonly _tag = "UnauthenticatedSessionError" as const;

	constructor(message = "An authenticated session is required.") {
		super(message);
		this.name = "UnauthenticatedSessionError";
	}
}

function normalizeOrganizationId(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function getActiveOrganizationId(
	session: Pick<AppSession, "session"> | null | undefined,
): string | undefined {
	return normalizeOrganizationId(session?.session.activeOrganizationId);
}

/** The single supported way to obtain the tenant id for row-level-security scoping. */
export function requireActiveOrganizationId(session: AppSession | null | undefined): string {
	if (!session) {
		throw new UnauthenticatedSessionError();
	}
	const organizationId = getActiveOrganizationId(session);
	if (!organizationId) {
		throw new MissingActiveOrganizationError(session.session.userId);
	}
	return organizationId;
}

export function requireSession(session: AppSession | null | undefined): AppSession {
	if (!session) {
		throw new UnauthenticatedSessionError();
	}
	return session;
}

/** True while a platform operator is acting as another user; audit records must say so. */
export function isImpersonatedSession(session: AppSession | null | undefined): boolean {
	return Boolean(normalizeOrganizationId(session?.session.impersonatedBy));
}

export interface OrganizationMembership {
	readonly organizationId: string;
	readonly role: string;
}

export interface SessionOrganizationRepository {
	/**
	 * Membership for the requested organization, or the user's default organization when
	 * `organizationId` is omitted. Returning `null` means the user belongs to no organization
	 * (or is not a member of the requested one) — the session then carries no tenant claim.
	 */
	readonly findMembership: (
		userId: string,
		organizationId?: string,
	) => Promise<OrganizationMembership | null>;
}

export interface SessionOrganizationContext {
	readonly activeOrganizationId?: string;
	readonly activeOrganizationRole?: string;
}

/**
 * Resolves the organization context for a session.
 *
 * An `activeOrganizationId` already on the session is re-verified against membership rather
 * than trusted: a member removed from an organization must lose the claim on the next refresh.
 */
export async function resolveSessionOrganizationContext(input: {
	readonly userId: string;
	readonly activeOrganizationId?: string | null;
	readonly repository: SessionOrganizationRepository;
}): Promise<SessionOrganizationContext> {
	const requested = normalizeOrganizationId(input.activeOrganizationId);
	const membership = await input.repository.findMembership(input.userId, requested);
	if (!membership) {
		return {};
	}
	return {
		activeOrganizationId: membership.organizationId,
		activeOrganizationRole: membership.role,
	};
}

/**
 * `databaseHooks.session.create.before` body: stamps the tenant claim onto the row so every
 * later request reads it straight off the session without a membership lookup.
 */
export function createSessionOrganizationHook(repository: SessionOrganizationRepository) {
	return async (session: {
		userId: string;
		activeOrganizationId?: string | null;
	}): Promise<{ data: { activeOrganizationId?: string } }> => {
		const context = await resolveSessionOrganizationContext({
			userId: session.userId,
			activeOrganizationId: session.activeOrganizationId,
			repository,
		});
		return {
			data: context.activeOrganizationId
				? { activeOrganizationId: context.activeOrganizationId }
				: {},
		};
	};
}
