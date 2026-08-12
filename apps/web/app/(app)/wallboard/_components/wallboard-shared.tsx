"use client";

import { Badge } from "~/components/ui/badge";
import { formatServiceLevel, serviceLevelTone, type WaitTone } from "~/lib/cdr/queue-stats";
import { cn } from "~/lib/cn";
import type { ReactNode } from "react";

/**
 * The two pieces the wallboard and the operator panel both draw, so the two screens cannot disagree
 * about what a service level looks like or what "no traffic" reads as.
 *
 * The decisions BEHIND them — what a wait formats as, when a tile stops looking calm, how a null
 * service level is worded — are in `lib/cdr/queue-stats.ts`, where they are pure and tested. This
 * file is only the markup.
 *
 * ## Read at TV distance
 *
 * These are deliberately larger than anything else in the app, which is the one visual rule this
 * screen has. A wallboard is not read by the person holding the mouse: it is on a wall, several
 * metres away, and the numbers somebody needs from there (how many are waiting, how long the worst
 * one has held) must be legible while the labels around them need not be. Hence a `text-4xl` value
 * over a `text-xs` label — a ratio nothing else in this app uses, and the reason these exist
 * instead of the modest `LiveTile` the queue's own page already had.
 */

export function WallTile({
	label,
	value,
	hint,
	tone = "neutral",
}: {
	label: string;
	value: string;
	hint?: ReactNode;
	/** `alert` is the one that has to catch an eye from across a room. */
	tone?: WaitTone;
}) {
	return (
		<div
			className={cn(
				"rounded-panel border px-4 py-3",
				tone === "alert"
					? "border-danger/40 bg-danger-subtle"
					: tone === "busy"
						? "border-warning/40 bg-warning-subtle"
						: "border-border bg-surface",
			)}
		>
			<p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
			<p
				className={cn(
					"mt-1 text-4xl leading-none font-semibold",
					tone === "alert" ? "text-danger" : tone === "busy" ? "text-warning" : "text-foreground",
				)}
				data-tabular
			>
				{value}
			</p>
			{hint ? <p className="mt-1.5 text-xs text-subtle-foreground">{hint}</p> : null}
		</div>
	);
}

/**
 * The service level, coloured against the target and never lying about an idle queue.
 *
 * `null` renders as words rather than as a percentage, which is the single distinction this whole
 * screen turns on: a queue nobody rang has no service level, and `0%` would put it in the same
 * colour as a queue that is collapsing.
 */
export function ServiceLevelBadge({ serviceLevelPct }: { serviceLevelPct: number | null }) {
	return (
		<Badge tone={serviceLevelTone(serviceLevelPct)} data-tabular>
			{formatServiceLevel(serviceLevelPct)}
		</Badge>
	);
}
