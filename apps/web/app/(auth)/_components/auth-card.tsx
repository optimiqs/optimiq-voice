import type { ReactNode } from "react";

/**
 * The card every auth page renders into.
 *
 * `title` is the page's `<h1>` — an auth screen has exactly one thing to say, and heading
 * navigation must land on it.
 */
export function AuthCard({
	title,
	description,
	children,
	footer,
}: {
	title: string;
	description?: string;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<div className="w-full max-w-sm">
			<div className="rounded-panel border border-border bg-surface p-6 shadow-raised">
				<div className="mb-6 flex flex-col gap-1.5">
					<h1 className="text-xl font-semibold tracking-tight text-balance text-foreground">
						{title}
					</h1>
					{description ? (
						<p className="text-sm text-pretty text-muted-foreground">{description}</p>
					) : null}
				</div>
				{children}
			</div>
			{footer ? <p className="mt-4 text-center text-sm text-muted-foreground">{footer}</p> : null}
		</div>
	);
}
