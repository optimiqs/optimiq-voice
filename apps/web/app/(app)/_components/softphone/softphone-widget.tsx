"use client";

import { useEffect, useState } from "react";
import { PhoneIcon } from "~/components/ui/icons";
import { cn } from "~/lib/cn";
import { useSoftphone } from "../../_context/softphone-context";
import { SoftphoneDialer } from "./softphone-dialer";

/**
 * The always-available softphone, docked bottom-right of the app shell.
 *
 * It is a global widget rather than a page so a call survives navigation: the user can dial from
 * here, walk through extensions and CDR while it rings, and answer without losing the page they
 * were on. It also lives at `/softphone` as a full page (for a focused view and the honesty note),
 * but the docked launcher is where the phone actually belongs.
 *
 * ## The gate
 *
 * Renders NOTHING until the credentials query resolves an extension for the caller. A user who
 * holds no extension never sees a phone — the feature is gated on the one fact that makes it
 * meaningful, exactly as the brief asks.
 */
export function SoftphoneWidget() {
	const phone = useSoftphone();
	const [open, setOpen] = useState(false);

	const ringingIncoming =
		phone.state.call.status === "ringing" && phone.state.call.direction === "incoming";

	// A ringing call opens the panel on its own — a phone you cannot see ringing is a missed call.
	useEffect(() => {
		if (ringingIncoming) {
			setOpen(true);
		}
	}, [ringingIncoming]);

	// The gate: no extension, no phone. `isLoading` also hides it until the answer is known.
	if (phone.isLoading || !phone.extension) {
		return null;
	}

	const inCall = phone.state.call.status === "ringing" || phone.state.call.status === "active";

	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-3">
			{open ? (
				<section
					aria-label="Softphone"
					className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] rounded-panel border border-border bg-surface p-4 shadow-overlay"
				>
					<div className="mb-3 flex items-center justify-between">
						<h2 className="text-sm font-semibold text-foreground">Phone</h2>
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="rounded-field px-2 py-1 text-xs text-muted-foreground hover:bg-hover hover:text-foreground"
						>
							Close
						</button>
					</div>
					<SoftphoneDialer />
				</section>
			) : null}

			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-label={open ? "Hide softphone" : "Show softphone"}
				aria-expanded={open}
				className={cn(
					"pointer-events-auto flex size-12 items-center justify-center rounded-full text-primary-foreground shadow-overlay transition-colors",
					inCall ? "bg-success" : "bg-primary hover:bg-primary-hover",
					ringingIncoming && "animate-pulse",
				)}
			>
				<PhoneIcon aria-hidden="true" className="size-5" />
			</button>
		</div>
	);
}
