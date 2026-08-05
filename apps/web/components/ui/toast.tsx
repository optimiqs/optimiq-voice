"use client";

import { useTheme } from "next-themes";
import { Toaster as SonnerToaster, toast } from "sonner";

/**
 * Toasts are for the OUTCOME of a user-initiated action ("Invitation sent", "Could not remove
 * member"). Anything a user must act on belongs in the page — a toast that disappears cannot be
 * re-read, and a form error inside a toast is unreachable for a screen-reader user who has moved
 * focus back to the field.
 */
export function Toaster() {
	const { resolvedTheme } = useTheme();

	return (
		<SonnerToaster
			theme={resolvedTheme === "dark" ? "dark" : "light"}
			position="bottom-right"
			closeButton
			richColors
			toastOptions={{
				classNames: {
					toast: "rounded-panel border border-border bg-surface text-foreground shadow-overlay",
					description: "text-muted-foreground",
				},
			}}
		/>
	);
}

export { toast };
