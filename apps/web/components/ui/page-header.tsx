import { cn } from "~/lib/cn";
import type { ReactNode } from "react";

export function PageHeader({
	title,
	description,
	actions,
	className,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<header className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
			<div className="flex min-w-0 flex-col gap-1">
				<h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
				{description ? (
					<p className="max-w-prose text-sm text-muted-foreground">{description}</p>
				) : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</header>
	);
}
