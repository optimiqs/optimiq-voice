import type { AppSession, AppSessionRecord, AppSessionUser, Permission } from "@optimiq-voice/auth";

/**
 * The single place a resolved session is written to and read from the HTTP request.
 *
 * Nothing outside `src/auth/` parses a cookie, a bearer token or an API key header: the Fastify
 * `preHandler` hook resolves the caller once and everything downstream reads this property.
 */

export const APP_SESSION_REQUEST_KEY = "optimiqVoiceSession";

interface AppSessionCarrier {
	[APP_SESSION_REQUEST_KEY]?: AppSession | null;
}

/** The subset of better-auth's `getSession` payload this application depends on. */
export interface RawAuthSession {
	readonly session: {
		readonly id: string;
		readonly userId: string;
		readonly token: string;
		readonly expiresAt: Date;
		readonly activeOrganizationId?: string | null;
		readonly impersonatedBy?: string | null;
		readonly ipAddress?: string | null;
		readonly userAgent?: string | null;
	};
	readonly user: {
		readonly id: string;
		readonly email: string;
		readonly name: string;
		readonly emailVerified: boolean;
		readonly image?: string | null;
		readonly role?: string | null;
		readonly banned?: boolean | null;
		readonly twoFactorEnabled?: boolean | null;
	};
}

/** Narrows better-auth's payload to the application's own session shape. */
export function toAppSession(raw: RawAuthSession): AppSession {
	const session: AppSessionRecord = {
		id: raw.session.id,
		userId: raw.session.userId,
		token: raw.session.token,
		expiresAt: raw.session.expiresAt,
		activeOrganizationId: raw.session.activeOrganizationId ?? null,
		impersonatedBy: raw.session.impersonatedBy ?? null,
		ipAddress: raw.session.ipAddress ?? null,
		userAgent: raw.session.userAgent ?? null,
	};
	const user: AppSessionUser = {
		id: raw.user.id,
		email: raw.user.email,
		name: raw.user.name,
		emailVerified: raw.user.emailVerified,
		image: raw.user.image ?? null,
		role: raw.user.role ?? null,
		banned: raw.user.banned ?? null,
		twoFactorEnabled: raw.user.twoFactorEnabled ?? null,
	};
	return { session, user };
}

export function withResolvedAccess(
	session: AppSession,
	activeOrganizationRole: string | null,
	permissions: readonly Permission[],
): AppSession {
	return { ...session, activeOrganizationRole, permissions };
}

function asCarrier(request: unknown): AppSessionCarrier | null {
	return typeof request === "object" && request !== null ? (request as AppSessionCarrier) : null;
}

export function setSessionOnRequest(request: unknown, session: AppSession | null): void {
	const carrier = asCarrier(request);
	if (carrier) {
		carrier[APP_SESSION_REQUEST_KEY] = session;
	}
}

/** The resolved session for this request, or `null` when the caller is anonymous. */
export function getSession(request: unknown): AppSession | null {
	return asCarrier(request)?.[APP_SESSION_REQUEST_KEY] ?? null;
}
