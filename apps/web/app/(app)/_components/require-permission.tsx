"use client";

import { EmptyState } from "~/components/ui/empty-state";
import { useAnyPermission, useEveryPermission } from "../_context/session-context";
import type { ReactNode } from "react";
import type { Permission } from "~/lib/permissions";

/**
 * Renders `children` only when the session carries the required permissions.
 *
 * `mode="every"` (the default) is for a surface that needs all of a set; `mode="any"` is for a
 * nav entry or a page that has several ways in — `cdr.read` OR `cdr.read.own` both justify showing
 * call history, they just show different rows.
 *
 * A gate is a courtesy, not a control. `fallback` defaults to nothing at all because the common
 * case is hiding a button; pass `<PermissionDenied />` when a whole route is blocked and silence
 * would look like a broken page.
 */
export function RequirePermission({
	permissions,
	mode = "every",
	fallback = null,
	children,
}: {
	permissions: readonly Permission[];
	mode?: "every" | "any";
	fallback?: ReactNode;
	children: ReactNode;
}) {
	const hasEvery = useEveryPermission(permissions);
	const hasAny = useAnyPermission(permissions);
	const allowed = mode === "any" ? hasAny : hasEvery;

	return allowed ? <>{children}</> : <>{fallback}</>;
}

export function PermissionDenied({ what = "this page" }: { what?: string }) {
	return (
		<EmptyState
			title="You do not have access"
			description={`Your role in this organization does not include permission to view ${what}. An administrator can change it under Settings → Members.`}
		/>
	);
}
