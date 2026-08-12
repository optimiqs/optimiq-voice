"use client";

import { useState } from "react";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { formatBytes, formatDuration } from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { usePermission } from "../../_context/session-context";
import { useDeleteRecording, useRecordingDownloadUrl } from "../../_hooks/use-cdr-queries";
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
 *
 * ## Delete lives here rather than as a row action, and is a third grant
 *
 * `recordings.delete` is deliberately separate from `recordings.download` in the registry: one of
 * these lets you hear a conversation and the other destroys the only copy of it, and a role that
 * reviews calls is not by that fact a role that may remove them from the record. So the button is
 * gated on its own permission and confirms before it acts.
 *
 * It sits with the media controls rather than in a row menu because it is a fact about the MEDIA,
 * not about the row: the object is deleted and the recording row survives as a tombstone with the
 * date its audio went, which is precisely the state this component already renders. Putting it
 * beside Play means the same control that says "there is audio here" is the one that removes it,
 * and it works identically wherever a recording is shown — the recordings list and an expanded
 * call in the history both get it without either screen knowing.
 */
export function RecordingPlayer({
	recording,
	compact = false,
}: {
	recording: RecordingRow;
	compact?: boolean;
}) {
	const mint = useRecordingDownloadUrl();
	const remove = useDeleteRecording();
	const canDownload = usePermission("recordings.download");
	const canDelete = usePermission("recordings.delete");
	const [source, setSource] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	const purged = recording.deletedAt !== null;

	/**
	 * A tombstone says WHEN the audio went and not by whom, because the row does not record that —
	 * a retention purge and a deliberate delete both set `deleted_at` and nothing else. The audit
	 * ledger is where "who" lives, and claiming either cause here would be a guess on the one screen
	 * whose remaining job is to be accurate about a recording that no longer exists.
	 */
	if (purged) {
		return (
			<p className={cn("text-xs text-muted-foreground", compact && "px-0")}>
				Media deleted on {new Date(recording.deletedAt as string).toLocaleDateString()} — by the
				retention policy, or on request. The record is kept for audit; the audit log says which.
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

			{canDelete ? (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						remove.reset();
						setConfirmingDelete(true);
					}}
					disabled={remove.isPending}
				>
					Delete
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

			<ConfirmDialog
				open={confirmingDelete}
				onOpenChange={(open) => {
					if (!open) {
						setConfirmingDelete(false);
						remove.reset();
					}
				}}
				title="Delete this recording?"
				description="The audio is destroyed and cannot be recovered. The recording's row stays behind as a record that it existed and was removed, with today's date on it, and an audit entry naming it is written — so the call history still shows that this call was recorded."
				confirmLabel="Delete audio"
				destructive
				pending={remove.isPending}
				onConfirm={() => {
					remove.mutate(recording.id, { onSuccess: () => setConfirmingDelete(false) });
				}}
			/>
		</div>
	);
}
