"use client";

import { cn } from "~/lib/cn";
import { Badge } from "../ui/badge";
import type { ReactNode } from "react";
import type { WireDiagnostic } from "~/lib/pbx/contracts";

/**
 * What the routing compiler had to say about a change that WAS saved.
 *
 * This is the single most important piece of copy in the PBX area to get right. A warning and a
 * rollback look almost identical in a REST response — both are a list of diagnostics with a
 * severity — and they mean opposite things:
 *
 * - `warnings[]` on a `200`/`201`: **the write succeeded.** The configuration is questionable
 *   (a ring group with no members answers nothing) but it is in the database.
 * - `ROUTING_COMPILE_FAILED` on a `422`: **the write was rolled back.** Nothing changed.
 *
 * So the two get different components and deliberately different visual language: this one is
 * `warning`-toned, headed "Saved with warnings", and says so in the first four words. The
 * rollback is `danger`-toned and says "Not saved" (see `RollbackBanner`). Using one amber box for
 * both is how an admin comes to believe a change landed when it did not.
 */
export function WarningsBanner({
	warnings,
	className,
	title = "Saved with warnings",
	description = "The change is live. These are things the routing compiler thinks you will want to fix.",
}: {
	warnings: readonly WireDiagnostic[];
	className?: string;
	title?: string;
	description?: string;
}) {
	if (warnings.length === 0) {
		return null;
	}

	return (
		<section
			aria-label={title}
			className={cn(
				"flex flex-col gap-2 rounded-panel border border-warning/40 bg-warning-subtle px-4 py-3",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone="warning">{title}</Badge>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<DiagnosticList diagnostics={warnings} />
		</section>
	);
}

/**
 * Something THIS UI noticed, with no compiler diagnostic behind it.
 *
 * A queue with no staffed tier rings nobody and ejects its callers into the timeout branch — but
 * `affectsRouting` says a tier is not a routing input, so the compiler never looks and there is no
 * code to quote. {@link WarningsBanner} would therefore have to be handed an invented one, and a
 * fabricated `code` in the same mono line the real ones use is a lie that costs someone an hour in
 * `packages/routing` looking for it.
 *
 * So the observation is made in its own voice: same amber, no code, no subject.
 */
export function NoticeBanner({
	title,
	description,
	className,
}: {
	title: string;
	description: ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-label={title}
			className={cn(
				"flex flex-col gap-2 rounded-panel border border-warning/40 bg-warning-subtle px-4 py-3",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone="warning">{title}</Badge>
			</div>
			<p className="text-sm text-foreground">{description}</p>
		</section>
	);
}

/**
 * A compile-on-write rollback. The write did NOT happen.
 *
 * `danger`, not `warning`, and the headline is about what did not occur rather than about what
 * the compiler found — because the user's next question is "is my change saved?" and every second
 * they spend answering it from a list of diagnostics is a second they might spend assuming it is.
 */
export function RollbackBanner({
	diagnostics,
	className,
	message,
}: {
	diagnostics: readonly WireDiagnostic[];
	className?: string;
	message?: string;
}) {
	return (
		<section
			aria-label="Change rolled back"
			className={cn(
				"flex flex-col gap-2 rounded-panel border border-danger/40 bg-danger-subtle px-4 py-3",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone="danger">Not saved</Badge>
				<p className="text-xs text-foreground">
					{message ??
						"This change was rolled back because it would break call routing. Nothing was changed."}
				</p>
			</div>
			{diagnostics.length > 0 ? <DiagnosticList diagnostics={diagnostics} /> : null}
		</section>
	);
}

/**
 * Diagnostics, one per line.
 *
 * `subject` names the row the compiler was looking at, which is frequently NOT the row being
 * edited — a save on an IVR menu can produce a warning about the ring group one of its options
 * points at. Dropping the subject would leave "this has no members" attached to the wrong thing.
 */
export function DiagnosticList({ diagnostics }: { diagnostics: readonly WireDiagnostic[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{diagnostics.map((diagnostic, index) => (
				<li
					key={`${diagnostic.code}-${diagnostic.path ?? index}`}
					className="flex flex-col gap-0.5 text-sm text-foreground"
				>
					<span>{diagnostic.message}</span>
					<span className="font-mono text-[0.6875rem] text-muted-foreground">
						{diagnostic.code}
						{diagnostic.subject
							? ` · ${diagnostic.subject.kind} ${diagnostic.subject.name ?? diagnostic.subject.id}`
							: ""}
						{diagnostic.path ? ` · ${diagnostic.path}` : ""}
					</span>
				</li>
			))}
		</ul>
	);
}
