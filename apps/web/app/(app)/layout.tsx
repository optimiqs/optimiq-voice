"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { canAccessPage } from "~/lib/page-permissions";
import { createQueryClient } from "~/lib/query-client";
import { signInWithRedirect } from "~/lib/routes";
import { NoOrganization } from "./_components/no-organization";
import { PermissionDenied } from "./_components/require-permission";
import { Sidebar } from "./_components/sidebar";
import { LiveProvider } from "./_context/live-context";
import { SessionProvider, useSessionOverviewQuery } from "./_context/session-context";

/**
 * The authenticated shell.
 *
 * `QueryClientProvider` lives HERE, not at the root: the client is created once per mount of this
 * layout, so signing out unmounts it and takes the whole cache with it. A root-level client
 * outlives the session and hands the next user the previous one's data.
 *
 * `middleware.ts` has already bounced visitors with no session cookie — but a cookie is not a
 * session. This is the real gate: `GET /api/v1/me` is the server answering who the caller is and
 * what they may do, and until it returns nothing renders.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
	const [queryClient] = useState(createQueryClient);

	return (
		<QueryClientProvider client={queryClient}>
			<AuthenticatedShell>{children}</AuthenticatedShell>
		</QueryClientProvider>
	);
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
	const router = useRouter();
	const pathname = usePathname();
	const { data: session, isPending, error } = useSessionOverviewQuery();
	const redirected = useRef(false);

	/**
	 * A 401 here means the cookie was stale or forged. Redirect once — a guard that can fire twice
	 * races the router and can leave the user on a half-torn-down page.
	 */
	useEffect(() => {
		if (redirected.current || !(error instanceof ApiError) || !error.isUnauthenticated) {
			return;
		}
		redirected.current = true;
		router.replace(signInWithRedirect(pathname));
	}, [error, pathname, router]);

	if (isPending || (error && !session)) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-canvas">
				<LoadingPanel label="Loading your organization" />
			</div>
		);
	}

	if (!session) {
		return null;
	}

	/**
	 * A signed-in user with no active organization has nowhere to go: every PBX surface is
	 * org-scoped and the API answers 403 without the claim. Rather than a wall of denied pages,
	 * the shell is replaced by the one action that resolves it.
	 */
	if (!session.activeOrganization) {
		return (
			<SessionProvider overview={session}>
				<NoOrganization />
			</SessionProvider>
		);
	}

	const allowed = canAccessPage(pathname, session.permissions);

	/**
	 * `LiveProvider` sits INSIDE `SessionProvider` and inside this component's own gate, so the
	 * socket cannot be opened before the server has said who the caller is and which organization
	 * they are acting in. It opens nothing on its own — `LiveClient` connects on the first topic
	 * lease — so the pages that are ordinary CRUD never pay for it.
	 */
	return (
		<SessionProvider overview={session}>
			<LiveProvider>
				<div className="flex h-dvh overflow-hidden bg-canvas">
					<Sidebar />
					<main id="main" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
						<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-8">
							{allowed ? children : <PermissionDenied what="this page" />}
						</div>
					</main>
				</div>
			</LiveProvider>
		</SessionProvider>
	);
}
