import type { ReactNode } from "react";

/**
 * One shell for every auth screen. Each page owns only its card, so the landmark, the skip-link
 * target and the centring cannot drift apart the way they do when six routes hand-roll the same
 * wrapper.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
	return (
		<main
			id="main"
			className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 py-12"
		>
			<div className="mb-8 flex items-center gap-2">
				<span
					aria-hidden="true"
					className="flex size-8 items-center justify-center rounded-field bg-primary text-sm font-bold text-primary-foreground"
				>
					O
				</span>
				<span className="text-lg font-semibold tracking-tight text-foreground">Optimiq Voice</span>
			</div>
			{children}
		</main>
	);
}
