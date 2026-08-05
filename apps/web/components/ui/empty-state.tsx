import { cn } from "~/lib/cn";
import type { ReactNode } from "react";

/**
 * The empty state every list surface shares.
 *
 * An empty table is a dead end; an empty state names what would be here and offers the one action
 * that creates it. Every unbuilt PBX module in the app shell renders this rather than a blank
 * page, so a route that exists but has no data and a route that exists but has no feature look
 * the same to a user — and the `action` slot is where the real CRUD lands in P3/P5.
 */
export function EmptyState({
	icon,
	title,
	description,
	action,
	className,
}: {
	icon?: ReactNode;
	title: string;
	description: string;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center gap-3 rounded-panel border border-dashed border-border bg-surface/50 px-6 py-16 text-center",
				className,
			)}
		>
			{icon ? (
				<div
					aria-hidden="true"
					className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
				>
					{icon}
				</div>
			) : null}
			<div className="flex flex-col gap-1">
				<p className="text-sm font-semibold text-foreground">{title}</p>
				<p className="mx-auto max-w-prose text-sm text-balance text-muted-foreground">
					{description}
				</p>
			</div>
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	);
}
