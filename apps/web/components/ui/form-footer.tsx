import { Button } from "./button";
import type { ReactNode } from "react";

/**
 * The shared Cancel + primary submit pair for dialog and card footers.
 *
 * Render it INSIDE an existing `DialogFooter` / `CardFooter` — it does not draw the wrapper. The
 * point is that every form ends the same way: cancel on the left, primary on the right, one
 * loading treatment, and a submit button that stays live until the request actually starts (a
 * dead button explains nothing; a failed submit puts the message on the field that caused it).
 */
export function FormFooter({
	onCancel,
	cancelLabel = "Cancel",
	submitLabel,
	loadingLabel,
	loading = false,
	submitDisabled = false,
	submitType = "submit",
	onSubmit,
	destructive = false,
}: {
	onCancel: () => void;
	cancelLabel?: ReactNode;
	submitLabel: ReactNode;
	loadingLabel?: ReactNode;
	loading?: boolean;
	submitDisabled?: boolean;
	submitType?: "button" | "submit";
	onSubmit?: () => void;
	destructive?: boolean;
}) {
	return (
		<>
			<Button variant="secondary" type="button" onClick={onCancel} disabled={loading}>
				{cancelLabel}
			</Button>
			<Button
				variant={destructive ? "danger" : "primary"}
				type={submitType}
				onClick={submitType === "button" ? onSubmit : undefined}
				loading={loading}
				disabled={submitDisabled}
			>
				{loading ? (loadingLabel ?? submitLabel) : submitLabel}
			</Button>
		</>
	);
}
