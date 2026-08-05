import { cn } from "~/lib/cn";
import type { ComponentProps } from "react";

export function Card({ className, ...props }: ComponentProps<"section">) {
	return (
		<section
			className={cn("rounded-panel border border-border bg-surface shadow-raised", className)}
			{...props}
		/>
	);
}

export function CardHeader({ className, ...props }: ComponentProps<"header">) {
	return (
		<header
			className={cn("flex flex-col gap-1 border-b border-border px-6 py-4", className)}
			{...props}
		/>
	);
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
	return <h2 className={cn("text-sm font-semibold text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
	return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("px-6 py-5", className)} {...props} />;
}

/** Right-aligned action bar. Visually distinct from the body so a save button never floats. */
export function CardFooter({ className, ...props }: ComponentProps<"footer">) {
	return (
		<footer
			className={cn(
				"flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-6 py-3",
				className,
			)}
			{...props}
		/>
	);
}
