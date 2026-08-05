"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn } from "~/lib/cn";
import type { ComponentProps } from "react";

/**
 * Modal dialog over Base UI.
 *
 * Overlay convention (oikos-care-web): a Dialog is for CREATE and EDIT. Long-form editing belongs
 * in a right-hand sheet, destructive confirmation in an alert dialog, and search in a command
 * dialog. Reaching for a Dialog for all four is how a product ends up with four different ways to
 * say the same thing.
 *
 * Base UI owns the focus trap, the scroll lock, the `aria-modal` wiring and restoring focus to the
 * trigger on close — none of which is reimplemented here.
 */

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export function DialogContent({
	className,
	children,
	...props
}: ComponentProps<typeof BaseDialog.Popup>) {
	return (
		<BaseDialog.Portal>
			<BaseDialog.Backdrop
				className={cn(
					"fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]",
					"transition-opacity duration-[--motion-base] ease-[--ease-standard]",
					"data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
				)}
			/>
			<BaseDialog.Popup
				className={cn(
					"fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
					"rounded-panel border border-border bg-surface p-6 shadow-overlay",
					"transition-[opacity,transform] duration-[--motion-base] ease-[--ease-emphasized]",
					"data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
					"data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
					className,
				)}
				{...props}
			>
				{children}
			</BaseDialog.Popup>
		</BaseDialog.Portal>
	);
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("mb-4 flex flex-col gap-1", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof BaseDialog.Title>) {
	return (
		<BaseDialog.Title
			className={cn("text-base font-semibold text-foreground", className)}
			{...props}
		/>
	);
}

export function DialogDescription({
	className,
	...props
}: ComponentProps<typeof BaseDialog.Description>) {
	return (
		<BaseDialog.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
	);
}

/** Actions are right-aligned and reversed on mobile so the primary action sits under the thumb. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
			{...props}
		/>
	);
}
