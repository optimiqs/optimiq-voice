"use client";

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "~/lib/cn";
import { focusRing } from "./focus-ring";
import type { ComponentProps, ReactNode } from "react";

/**
 * A boolean setting.
 *
 * A switch, not a checkbox, because these are settings that take effect on save rather than
 * selections within a set — "voicemail enabled" is a state the phone system is in, and the
 * control should read that way. Base UI supplies the `role="switch"`, the `aria-checked` state
 * and keyboard activation.
 */
export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
	return (
		<BaseSwitch.Root
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 cursor-default rounded-full border border-border bg-muted p-px",
				"transition-colors duration-[--motion-fast] ease-[--ease-standard]",
				"data-[checked]:border-primary data-[checked]:bg-primary",
				"data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
				focusRing,
				className,
			)}
			{...props}
		>
			<BaseSwitch.Thumb
				className={cn(
					"block size-4 rounded-full bg-surface shadow-raised",
					"transition-transform duration-[--motion-fast] ease-[--ease-standard]",
					"data-[checked]:translate-x-4",
				)}
			/>
		</BaseSwitch.Root>
	);
}

/**
 * A switch with its label and description, laid out as a row.
 *
 * The whole row is the label so the hit target is the width of the form rather than 36 pixels —
 * the difference between a control that is comfortable on a laptop trackpad and one that is not.
 */
export function SwitchRow({
	id,
	label,
	description,
	checked,
	onCheckedChange,
	disabled,
	className,
}: {
	id: string;
	label: string;
	description?: ReactNode;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("flex items-start justify-between gap-4 py-1", className)}>
			<label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm font-medium text-foreground">{label}</span>
				{description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
			</label>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onCheckedChange}
				disabled={disabled}
				className="mt-0.5"
			/>
		</div>
	);
}
