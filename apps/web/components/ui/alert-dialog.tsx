"use client";

import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "~/lib/cn";
import { Button } from "./button";
import type { ReactNode } from "react";

/**
 * Confirmation only — never a form.
 *
 * Base UI's AlertDialog differs from Dialog in exactly the way that matters here: it cannot be
 * dismissed by clicking the backdrop or pressing Escape without choosing. Deleting a trunk or
 * removing the last administrator should cost a deliberate click.
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	details,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	destructive = false,
	pending = false,
	onConfirm,
	trigger,
}: {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	title: string;
	description: ReactNode;
	/**
	 * Extra content between the description and the buttons — the one place a confirmation may
	 * carry structure. A `PBX_REFERENCED` 409 lists the rows that refused the delete AS LINKS, and
	 * a `description` string cannot hold a link the user can follow to go and fix them.
	 */
	details?: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
	pending?: boolean;
	onConfirm: () => void;
	trigger?: ReactNode;
}) {
	return (
		<BaseAlertDialog.Root open={open} onOpenChange={onOpenChange}>
			{trigger ? <BaseAlertDialog.Trigger render={trigger as never} /> : null}
			<BaseAlertDialog.Portal>
				<BaseAlertDialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]",
						"transition-opacity duration-[--motion-base] ease-[--ease-standard]",
						"data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
					)}
				/>
				<BaseAlertDialog.Popup
					className={cn(
						"fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto",
						"rounded-panel border border-border bg-surface p-6 shadow-overlay",
						"transition-[opacity,transform] duration-[--motion-base] ease-[--ease-emphasized]",
						"data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
						"data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
					)}
				>
					<BaseAlertDialog.Title className="text-base font-semibold text-foreground">
						{title}
					</BaseAlertDialog.Title>
					<BaseAlertDialog.Description
						render={<div />}
						className="mt-1 text-sm text-muted-foreground"
					>
						{description}
					</BaseAlertDialog.Description>
					{details ? <div className="mt-4">{details}</div> : null}
					<div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<BaseAlertDialog.Close render={<Button variant="secondary">{cancelLabel}</Button>} />
						<Button
							variant={destructive ? "danger" : "primary"}
							loading={pending}
							onClick={onConfirm}
						>
							{confirmLabel}
						</Button>
					</div>
				</BaseAlertDialog.Popup>
			</BaseAlertDialog.Portal>
		</BaseAlertDialog.Root>
	);
}
