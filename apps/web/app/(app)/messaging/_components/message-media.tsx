"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useMessageMediaUrl } from "../../_hooks/use-messaging-queries";
import type { MessageMediaPart } from "~/lib/messaging/contracts";

/**
 * One MMS part, rendered from a URL that is minted when the part comes into view.
 *
 * ## Why the URL is fetched per part rather than carried on the row
 *
 * `POST messages/:id/media-url` returns a SIGNED, EXPIRING link. A thread that embedded those
 * links in its message rows would cache them for as long as React Query holds the page, and a
 * signature that outlives its cache entry is a broken image at the worst possible moment — the one
 * where somebody scrolls back to check what a customer sent. So the link is minted here, once per
 * mounted part, and nothing keeps it.
 *
 * ## An image renders; anything else is a link
 *
 * Guessing at a viewer for a PDF or a vCard would put a broken plugin where a download belongs.
 * The content type decides, and the fallback names the type and the size so a reader knows what
 * they are about to open.
 */
export function MessageMedia({ messageId, part }: { messageId: string; part: MessageMediaPart }) {
	const mint = useMessageMediaUrl();
	const [url, setUrl] = useState<string | null>(null);
	const { mutate } = mint;

	useEffect(() => {
		let live = true;
		mutate(
			{ messageId, objectKey: part.objectKey },
			{
				onSuccess: (link) => {
					if (live) {
						setUrl(link.url);
					}
				},
			},
		);
		return () => {
			live = false;
		};
	}, [mutate, messageId, part.objectKey]);

	const label = part.contentType;

	if (mint.isError) {
		return (
			<p className="text-xs text-danger">
				That attachment could not be opened ({label}). The signed link may have expired — reload the
				thread.
			</p>
		);
	}

	if (url === null) {
		return (
			<span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
				<Spinner label="Loading attachment" />
				{label}
			</span>
		);
	}

	if (part.contentType.startsWith("image/")) {
		return (
			<a href={url} target="_blank" rel="noreferrer" className="block">
				{/* eslint-disable-next-line @next/next/no-img-element -- the source is a signed, expiring URL on the object store's host, which Next's optimizer cannot be configured for and must not cache. */}
				<img
					src={url}
					alt={`Attachment, ${label}`}
					className="max-h-64 max-w-full rounded-field border border-border object-contain"
				/>
			</a>
		);
	}

	return (
		<Button
			size="sm"
			variant="secondary"
			render={
				<a href={url} target="_blank" rel="noreferrer">
					Open attachment ({label})
				</a>
			}
		/>
	);
}
