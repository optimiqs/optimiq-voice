"use client";

import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/cn";
import { focusRing } from "./focus-ring";

/**
 * The focus ring, the disabled treatment and the transition are shared with every other control
 * (see `./focus-ring`) so a Button, a Select trigger and an icon button are keyboard-identical.
 */
const buttonVariants = cva(
	cn(
		"inline-flex shrink-0 items-center justify-center gap-2 rounded-field font-medium whitespace-nowrap",
		"transition-colors duration-[--motion-fast] ease-[--ease-standard]",
		"disabled:pointer-events-none disabled:opacity-50",
		"[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
		focusRing,
	),
	{
		variants: {
			variant: {
				primary: "bg-primary text-primary-foreground hover:bg-primary-hover shadow-raised",
				secondary: "border border-border bg-surface text-foreground hover:bg-hover shadow-raised",
				ghost: "text-muted-foreground hover:bg-hover hover:text-foreground",
				danger: "bg-danger text-danger-foreground hover:bg-danger-hover shadow-raised",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				sm: "h-8 px-3 text-sm",
				md: "h-9 px-4 text-sm",
				lg: "h-10 px-5 text-[0.9375rem]",
				icon: "size-9",
			},
		},
		defaultVariants: {
			variant: "secondary",
			size: "md",
		},
	},
);

export interface ButtonProps
	extends useRender.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
	/** Blocks interaction and shows a busy cursor without collapsing the button's width. */
	loading?: boolean;
}

/**
 * `render` is Base UI's composition escape hatch: `<Button render={<Link href="/x" />}>` produces
 * a real anchor that still looks and focuses like a button. That is why this is not a plain
 * `<button>` with a `className` — a nav item that renders as a `<button>` breaks middle-click,
 * "open in new tab" and every assistive technology that distinguishes navigation from action.
 */
export function Button({
	className,
	variant,
	size,
	loading = false,
	disabled,
	render,
	...props
}: ButtonProps) {
	return useRender({
		defaultTagName: "button",
		render,
		props: {
			type: "button",
			...props,
			disabled: disabled === true || loading,
			"aria-busy": loading || undefined,
			className: cn(buttonVariants({ variant, size }), loading && "cursor-progress", className),
		},
	});
}

export { buttonVariants };
