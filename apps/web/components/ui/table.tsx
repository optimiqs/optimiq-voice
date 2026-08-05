import { cn } from "~/lib/cn";
import type { ComponentProps } from "react";

/**
 * Table primitives.
 *
 * The wrapper owns the horizontal scroll so a wide CDR or provisioning table scrolls inside its
 * own box instead of making the whole page scroll sideways — the single most common way an admin
 * layout breaks on a laptop.
 *
 * These are presentation only: sorting, pagination and column sizing come from TanStack Table at
 * the call site, so a plain list never pays for a data grid it does not use.
 */

export function TableContainer({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"w-full overflow-x-auto rounded-panel border border-border bg-surface",
				className,
			)}
			{...props}
		/>
	);
}

export function Table({ className, ...props }: ComponentProps<"table">) {
	return <table className={cn("w-full caption-bottom text-sm", className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
	return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
	return (
		<tbody
			className={cn("[&_tr:last-child]:border-0 [&_tr]:border-b [&_tr]:border-border", className)}
			{...props}
		/>
	);
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
	return (
		<tr
			className={cn(
				"transition-colors duration-[--motion-fast] hover:bg-hover data-[selected]:bg-accent",
				className,
			)}
			{...props}
		/>
	);
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
	return (
		<th
			scope="col"
			className={cn(
				"h-10 px-4 text-left align-middle text-xs font-medium tracking-wide text-muted-foreground uppercase",
				className,
			)}
			{...props}
		/>
	);
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
	return <td className={cn("px-4 py-3 align-middle text-foreground", className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
	return <caption className={cn("mt-3 text-sm text-muted-foreground", className)} {...props} />;
}
