"use client";

import { cn } from "~/lib/cn";
import { isCompileRollback, pbxDiagnostics, pbxFormMessage } from "~/lib/pbx/errors";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { FormFooter } from "../ui/form-footer";
import { RollbackBanner } from "./warnings-banner";
import type { ReactNode } from "react";

/**
 * The shell every PBX create/edit form sits in.
 *
 * It owns the three things every one of them needs and none of them should re-implement:
 *
 * 1. **A real `<form>`** with `noValidate`, submitting on Enter. A dialog whose primary button is
 *    an `onClick` handler cannot be submitted from the keyboard, which is how most of these are
 *    filled in.
 * 2. **The failure banner**, and specifically the distinction between a rollback and everything
 *    else. `ROUTING_COMPILE_FAILED` means the write did not happen, and that sentence has to be
 *    on screen — the per-field messages below it say what is wrong, never whether it saved.
 * 3. **A scrollable body**, because a PBX entity has more fields than a viewport has room, and a
 *    dialog whose submit button is below the fold is a dialog with no submit button.
 */
export function EntityFormDialog({
	open,
	onOpenChange,
	title,
	description,
	submitLabel,
	pending,
	error,
	onSubmit,
	children,
	size = "md",
	footerNote,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	submitLabel: string;
	pending: boolean;
	/** The last mutation failure. Field-level messages are the caller's job; this shows the rest. */
	error: unknown;
	onSubmit: () => void;
	children: ReactNode;
	size?: "md" | "lg";
	footerNote?: ReactNode;
}) {
	const rollback = isCompileRollback(error);
	const formMessage = error === null || error === undefined ? undefined : pbxFormMessage(error);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className={cn(
					"flex max-h-[calc(100dvh-3rem)] flex-col",
					size === "lg" ? "w-[min(46rem,calc(100vw-2rem))]" : "w-[min(34rem,calc(100vw-2rem))]",
				)}
			>
				<form
					noValidate
					className="flex min-h-0 flex-col"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description ? <DialogDescription>{description}</DialogDescription> : null}
					</DialogHeader>

					<div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1 pb-1">
						{rollback ? (
							<RollbackBanner diagnostics={pbxDiagnostics(error)} message={formMessage} />
						) : formMessage ? (
							<p
								role="alert"
								className="rounded-panel border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-foreground"
							>
								{formMessage}
							</p>
						) : null}
						{children}
					</div>

					{footerNote ? (
						<p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
							{footerNote}
						</p>
					) : null}

					<DialogFooter>
						<FormFooter
							onCancel={() => onOpenChange(false)}
							submitLabel={submitLabel}
							loadingLabel="Saving"
							loading={pending}
						/>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A titled group of fields inside a form. Keeps a 20-field entity readable. */
export function FormSection({
	title,
	description,
	children,
	columns = 2,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
	columns?: 1 | 2;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-0.5">
				<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					{title}
				</h3>
				{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
			</div>
			<div className={cn("grid gap-4", columns === 2 ? "sm:grid-cols-2" : "grid-cols-1")}>
				{children}
			</div>
		</section>
	);
}
