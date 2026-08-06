"use client";

import { useState } from "react";
import { cn } from "~/lib/cn";
import { Button } from "../ui/button";
import { inputClassName } from "../ui/field";

/**
 * Listen to one stored object, through a credential that does not exist until somebody asks.
 *
 * ## Why the `<audio>` is not rendered up front
 *
 * Every playable object in this app — a voicemail message, a prompt, a hold-music file, a mailbox
 * greeting — is reached through a URL the server SIGNS on request and expires within minutes.
 * Rendering an `<audio src>` per row would mint one live grant per row on every render: twenty
 * credentials in the DOM, nineteen of them never played, all of them in the browser's history and
 * in whatever proxies sit between. So the default state is a button, and the fetch happens on the
 * press that means "I want to hear this".
 *
 * ## Why this takes a thunk rather than a mutation
 *
 * Four callers, four different endpoints, and two of them need extra arguments the row knows and
 * this component has no business knowing (`boxId` and `greetingId`, `mohClassId` and `fileId`).
 * Passing a `UseMutationResult` would drag React Query's five generic parameters through the
 * component set for no gain, and would make the shared piece care which of the four it is showing.
 * A `() => Promise<{ url }>` is the whole contract, and `mutateAsync` already has that shape.
 *
 * The consequence is that the pending and failed states live HERE, in local state, rather than
 * being read off the mutation. That is the right side of the trade: a mutation instance shared by
 * a whole table would put every row into "Preparing…" when one of them was pressed, and this way a
 * caller cannot get that wrong.
 *
 * ## Why the failure is inline text and not a toast
 *
 * A mint fails for reasons that are about THIS row — the object is gone from the store, the caller
 * lost the permission between page load and press — and the row is where the sentence has to be,
 * next to the control that is still there to be pressed again.
 */
export function MediaPreviewButton({
	mint,
	label,
	disabled = false,
	failureMessage = "This audio could not be prepared for playback.",
	className,
}: {
	/** Mints a fresh, short-lived URL. Usually a `mutateAsync` closed over the row's identifiers. */
	readonly mint: () => Promise<{ readonly url: string }>;
	/** Names what is being played, for the audio element's accessible name. Not shown visually. */
	readonly label: string;
	readonly disabled?: boolean;
	readonly failureMessage?: string;
	readonly className?: string;
}) {
	const [source, setSource] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (source !== null) {
		return (
			<audio
				controls
				autoPlay
				src={source}
				className={cn(inputClassName, "h-8 max-w-full p-0", className)}
				aria-label={label}
			>
				{/*
				 * An empty caption track. The element is required for a media element to be valid and
				 * for browsers that surface a captions control to have something to attach it to; there
				 * is no transcript to point it at, and a `<track>` with no `src` is the honest version of
				 * "this recording has no captions" rather than a link to a file that does not exist.
				 */}
				<track kind="captions" />
			</audio>
		);
	}

	return (
		<div className={cn("flex flex-col gap-1", className)}>
			<Button
				size="sm"
				variant="secondary"
				disabled={disabled || pending}
				aria-label={`Play ${label}`}
				onClick={() => {
					setPending(true);
					setError(null);
					mint().then(
						(link) => {
							setPending(false);
							setSource(link.url);
						},
						(reason: unknown) => {
							setPending(false);
							const message = reason instanceof Error ? reason.message : "";
							setError(message.length > 0 ? message : failureMessage);
						},
					);
				}}
			>
				{pending ? "Preparing…" : "Play"}
			</Button>
			{error !== null ? <span className="text-xs text-danger">{error}</span> : null}
		</div>
	);
}
