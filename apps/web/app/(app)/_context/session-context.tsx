"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { createContext, use, type ReactNode } from "react";
import { fetchSessionOverview, type SessionOverview } from "~/lib/api-client";
import { hasAnyPermission, hasEveryPermission, hasPermission } from "~/lib/permissions";
import { queryKeys } from "~/lib/query-keys";
import type { Permission } from "~/lib/permissions";

/**
 * The authenticated session, as the SERVER sees it.
 *
 * better-auth's own `useSession()` knows the user and the active organization id but not what the
 * membership role grants — role→permission expansion happens in `apps/api`'s
 * `role-permissions.ts`. `GET /api/v1/me` returns the resolved set, so the UI gates on exactly the
 * list the permission guard will check. Deriving permissions in the browser from a role string
 * would be a second implementation of authorization, and the two would drift.
 *
 * Held under one query key with `staleTime: Infinity`; switching organizations invalidates it.
 */

interface SessionContextValue {
	readonly overview: SessionOverview;
	readonly permissions: ReadonlySet<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
	overview,
	children,
}: {
	overview: SessionOverview;
	children: ReactNode;
}) {
	return (
		<SessionContext value={{ overview, permissions: new Set<string>(overview.permissions) }}>
			{children}
		</SessionContext>
	);
}

function useSessionContext(): SessionContextValue {
	const value = use(SessionContext);
	if (!value) {
		throw new Error(
			"useAppSession must be used inside the authenticated layout's SessionProvider.",
		);
	}
	return value;
}

/** The resolved session. Only callable below `app/(app)/layout.tsx`, which guarantees it exists. */
export function useAppSession(): SessionOverview {
	return useSessionContext().overview;
}

export function useActiveOrganization(): SessionOverview["activeOrganization"] {
	return useSessionContext().overview.activeOrganization;
}

/**
 * Whether the caller holds a permission.
 *
 * Presentation only — the API is the enforcement point. Use it to hide what would fail, never as
 * the reason something is safe.
 */
export function usePermission(permission: Permission): boolean {
	const { permissions } = useSessionContext();
	return hasPermission(permissions, permission);
}

export function useEveryPermission(required: readonly Permission[]): boolean {
	const { permissions } = useSessionContext();
	return hasEveryPermission(permissions, required);
}

export function useAnyPermission(required: readonly Permission[]): boolean {
	const { permissions } = useSessionContext();
	return hasAnyPermission(permissions, required);
}

/** The query the authenticated layout runs before it renders anything. */
export function useSessionOverviewQuery(): UseQueryResult<SessionOverview> {
	return useQuery({
		queryKey: queryKeys.session(),
		queryFn: fetchSessionOverview,
	});
}
