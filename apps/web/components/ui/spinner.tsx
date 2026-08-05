import { cn } from "~/lib/cn";

/**
 * `<output>` carries an implicit `role="status"`, so a screen reader announces the wait; the ring
 * itself is decorative and the label is visually hidden. A bare spinning `<div>` is silence for
 * anyone not looking at it.
 */
export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
	return (
		<output className={cn("inline-flex items-center", className)}>
			<span
				aria-hidden="true"
				className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60"
			/>
			<span className="sr-only">{label}</span>
		</output>
	);
}

/** Full-height centred spinner for a route or panel that has nothing to show yet. */
export function LoadingPanel({ label = "Loading" }: { label?: string }) {
	return (
		<div className="flex min-h-40 items-center justify-center text-muted-foreground">
			<Spinner label={label} />
		</div>
	);
}
