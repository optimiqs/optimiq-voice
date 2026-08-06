"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import { formatBytes, formatDuration } from "~/lib/cdr/format";
import { usePermission } from "../../_context/session-context";
import { useRecordingDownloadUrl } from "../../_hooks/use-cdr-queries";
import type { RecordingRow } from "~/lib/cdr/contracts";

/**
 * Play or download one recording, through a signed URL minted on demand.
 *
 * ## Why the audio element is not rendered until the user asks
 *
 * The `src` is a signed URL that expires in minutes and is minted by a `POST`. Rendering an
 * `<audio src>` for every row of a list would mint a credential per row on every render — most of
 * them never played — and each of those is a live grant sitting in the DOM. Asking first means one
 * credential per actual listen.
 *
 * It also means the link is never stale: a URL minted at page load and clicked twenty minutes
 * later is a 410, which reads as "the recording is broken" rather than "the link timed out". A
 * fresh mint per play removes that failure entirely.
 *
 * ## Why download is a separate button rather than the same URL
 *
 * They are the same URL, and the difference is what the browser is asked to do with it. Playing
 * keeps the user on the page; downloading hands them a file. Splitting the buttons is what lets
 * the download be gated on `recordings.download` while a future "listen only" grant could still
 * play — and today both mint through the same permission, so the split costs nothing and is ready.
 */
export function RecordingPlayer({
	recording,
	compact = false,
}: {
	recording: RecordingRow;
	compact?: boolean;
}) {
	const mint = useRecordingDownloadUrl();
	const canDownload = usePermission("recordings.download");
	const [source, setSource] = useState<string | null>(null);

	const purged = recording.deletedAt !== null;

	if (purged) {
		return (
			<p className={cn("text-xs text-muted-foreground", compact && "px-0")}>
				Media purged by the retention policy on{" "}
				{new Date(recording.deletedAt as string).toLocaleDateString()}. The record is kept for
				audit.
			</p>
		);
	}

	const play = (): void => {
		mint.mutate(recording.id, {
			onSuccess: (link) => setSource(link.url),
		});
	};

	const download = (): void => {
		mint.mutate(recording.id, {
			onSuccess: (link) => {
				// A programmatic click rather than `window.open`: the popup blocker treats an opened
				// window as a popup and the Content-Disposition header does the rest.
				const anchor = document.createElement("a");
				anchor.href = link.url;
				anchor.download = "";
				document.body.append(anchor);
				anchor.click();
				anchor.remove();
			},
		});
	};

	return (
		<div className="flex flex-wrap items-center gap-2">
			{source === null ? (
				<Button size="sm" variant="secondary" onClick={play} disabled={mint.isPending}>
					{mint.isPending ? "Preparing…" : "Play"}
				</Button>
			) : (
				<audio
					controls
					autoPlay
					src={source}
					className="h-8 max-w-full"
					aria-label={`Recording from ${new Date(recording.createdAt).toLocaleString()}`}
				>
					<track kind="captions" />
				</audio>
			)}

			{canDownload ? (
				<Button size="sm" variant="ghost" onClick={download} disabled={mint.isPending}>
					Download
				</Button>
			) : null}

			<span className="text-xs text-muted-foreground" data-tabular>
				{formatDuration(recording.durationMs)}
				{recording.sizeBytes > 0 ? ` · ${formatBytes(recording.sizeBytes)}` : ""}
			</span>

			{mint.isError ? (
				<span className="text-xs text-danger">
					{/* The area's own errors are readable sentences; anything else falls back. */}
					{mint.error.message || "This recording could not be prepared for playback."}
				</span>
			) : null}
		</div>
	);
}
