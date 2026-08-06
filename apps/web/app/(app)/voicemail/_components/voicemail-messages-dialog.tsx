"use client";

import { useState } from "react";
import { MediaPreviewButton } from "~/components/pbx/media-preview-button";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { EmptyState } from "~/components/ui/empty-state";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { formatBytes, formatDuration } from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { DEFAULT_PAGE_LIMIT } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { useLiveVoicemail } from "../../_hooks/use-live-queries";
import {
	useDeleteVoicemailMessage,
	useSetVoicemailMessageRead,
	useVoicemailMessages,
	useVoicemailPlaybackUrl,
} from "../../_hooks/use-voicemail-queries";
import type {
	VoicemailBoxRow,
	VoicemailFolder,
	VoicemailMessageRow,
} from "~/lib/pbx/contracts";

/**
 * The contents of one mailbox.
 *
 * ## Why a dialog and not a page
 *
 * A message list is a thing you open, act on and close — you do not navigate to it, link to it or
 * come back to it. Making it a route would add a URL nobody shares, a back-button state nobody
 * wants, and a second place the mailbox list has to be fetched. The overlay convention this app
 * follows reserves dialogs for create and edit; this one is an exception it names, because the
 * alternative (a right-hand sheet) does not exist in the component set yet and inventing one for a
 * single caller is a worse trade than reusing the dialog at `lg`.
 *
 * ## Read/unread is a folder, and the badge says so
 *
 * `voicemail_message` has no `read` column: it has `new` / `saved` / `deleted`, which is the
 * vocabulary the MWI lamp is defined in. The server derives `read` for this screen's benefit and
 * the controls speak read/unread, but the FOLDER filter is offered too — because "where did my
 * deleted message go" is a real question and the trash is the only answer.
 *
 * ## Playback mints a fresh credential every time
 *
 * The `<audio>` element is not rendered until the user presses Play, for the reason
 * `recording-player.tsx` records at length: a signed URL per row on every render is a live grant
 * per row sitting in the DOM, most of them never played, all of them expiring in minutes.
 */

const FOLDER_TABS: readonly { readonly value: VoicemailFolder | "inbox"; readonly label: string }[] =
	[
		{ value: "inbox", label: "Inbox" },
		{ value: "new", label: "Unread" },
		{ value: "saved", label: "Read" },
		{ value: "deleted", label: "Trash" },
	];

export function VoicemailMessagesDialog({
	open,
	onOpenChange,
	box,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	box: VoicemailBoxRow | null;
}) {
	const [folder, setFolder] = useState<VoicemailFolder | "inbox">("inbox");
	const [page, setPage] = useState(1);

	const canWrite = usePermission("voicemail.write");
	const canDelete = usePermission("voicemail.delete");
	const canListen = usePermission("voicemail.listen");

	const list = useVoicemailMessages(open && box !== null ? box.id : undefined, {
		...(folder === "inbox" ? {} : { folder }),
		page,
		limit: DEFAULT_PAGE_LIMIT,
	});

	// The live overlay: the fetched counts are right when the page loaded, and this is what keeps
	// them right while it stays open. `?? fetched` in both directions — see `useLiveVoicemail`.
	const live = useLiveVoicemail();
	const liveCounts = box === null ? undefined : live.counts.get(box.id);
	const newCount = liveCounts?.newCount ?? list.mailbox?.newCount ?? 0;
	const savedCount = liveCounts?.savedCount ?? list.mailbox?.savedCount ?? 0;

	const setRead = useSetVoicemailMessageRead();
	const remove = useDeleteVoicemailMessage();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setFolder("inbox");
					setPage(1);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="flex max-h-[calc(100dvh-3rem)] w-[min(52rem,calc(100vw-2rem))] flex-col">
				<DialogHeader>
					<DialogTitle>
						{box === null ? "Messages" : `Mailbox ${box.mailboxNumber}`}
					</DialogTitle>
					<DialogDescription>
						{newCount} unread · {savedCount} read. Playback links are signed and expire within
						minutes, so they are never shareable by accident.
					</DialogDescription>
				</DialogHeader>

				<div className="mb-3 flex flex-wrap items-center gap-2">
					{FOLDER_TABS.map((tab) => (
						<Button
							key={tab.value}
							size="sm"
							variant={folder === tab.value ? "primary" : "secondary"}
							onClick={() => {
								setFolder(tab.value);
								setPage(1);
							}}
						>
							{tab.label}
							{tab.value === "new" && newCount > 0 ? ` (${newCount})` : ""}
						</Button>
					))}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					<MessagesTable
						boxId={box?.id ?? ""}
						rows={list.rows}
						isPending={list.query.isPending}
						folder={folder}
						canWrite={canWrite}
						canDelete={canDelete}
						canListen={canListen}
						pending={setRead.isPending || remove.isPending}
						onToggleRead={(row) => {
							setRead.mutate({ boxId: row.voicemailBoxId, messageId: row.id, read: !row.read });
						}}
						onDelete={(row) => {
							remove.mutate({
								boxId: row.voicemailBoxId,
								messageId: row.id,
								// A message already in the trash is purged; anything else is moved there. Two
								// presses of the same control, two different meanings — which is what every
								// mail client does and what stops one mis-click being unrecoverable.
								purge: row.folder === "deleted",
							});
						}}
					/>
				</div>

				<DialogFooter className="items-center justify-between sm:justify-between">
					<span className="text-xs text-muted-foreground" data-tabular>
						{list.total === 0
							? "No messages"
							: `Page ${page} of ${Math.max(1, list.totalPages)} · ${list.total} message${
									list.total === 1 ? "" : "s"
								}`}
					</span>
					<div className="flex items-center gap-2">
						<Button
							size="sm"
							variant="secondary"
							disabled={page <= 1}
							onClick={() => setPage((current) => Math.max(1, current - 1))}
						>
							Newer
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={page >= list.totalPages}
							onClick={() => setPage((current) => current + 1)}
						>
							Older
						</Button>
						<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
							Close
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MessagesTable({
	boxId,
	rows,
	isPending,
	folder,
	canWrite,
	canDelete,
	canListen,
	pending,
	onToggleRead,
	onDelete,
}: {
	boxId: string;
	rows: readonly VoicemailMessageRow[];
	isPending: boolean;
	folder: VoicemailFolder | "inbox";
	canWrite: boolean;
	canDelete: boolean;
	canListen: boolean;
	pending: boolean;
	onToggleRead: (row: VoicemailMessageRow) => void;
	onDelete: (row: VoicemailMessageRow) => void;
}) {
	if (isPending) {
		return <LoadingPanel label="Loading messages" />;
	}
	if (rows.length === 0) {
		return (
			<EmptyState
				title={folder === "deleted" ? "The trash is empty" : "No messages"}
				description={
					folder === "deleted"
						? "Deleted messages stay here until they are permanently removed."
						: "Messages appear here when a caller leaves one. Nothing has been recorded into this mailbox yet."
				}
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Messages in this mailbox, newest first</caption>
				<TableHeader>
					<TableRow>
						<TableHead>Received</TableHead>
						<TableHead>From</TableHead>
						<TableHead className="text-right">Length</TableHead>
						<TableHead className="text-right">Size</TableHead>
						<TableHead>State</TableHead>
						<TableHead>Audio</TableHead>
						<TableHead />
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id} className={cn(!row.read && "font-medium")}>
							<TableCell className="whitespace-nowrap" data-tabular>
								{new Date(row.receivedAt).toLocaleString()}
							</TableCell>
							<TableCell>
								<div className="flex flex-col">
									<span>{row.callerIdNumber ?? "Unknown"}</span>
									{row.callerIdName ? (
										<span className="text-xs text-muted-foreground">{row.callerIdName}</span>
									) : null}
								</div>
							</TableCell>
							<TableCell className="text-right whitespace-nowrap" data-tabular>
								{formatDuration(row.durationMs)}
							</TableCell>
							<TableCell className="text-right whitespace-nowrap" data-tabular>
								{formatBytes(row.sizeBytes ?? 0)}
							</TableCell>
							<TableCell>
								<Badge tone={row.folder === "deleted" ? "neutral" : row.read ? "neutral" : "accent"}>
									{row.folder === "deleted" ? "Deleted" : row.read ? "Read" : "Unread"}
								</Badge>
							</TableCell>
							<TableCell>
								<MessagePlayer boxId={boxId} message={row} canListen={canListen} />
							</TableCell>
							<TableCell className="whitespace-nowrap">
								{canWrite && row.folder !== "deleted" ? (
									<Button
										size="sm"
										variant="ghost"
										disabled={pending}
										onClick={() => onToggleRead(row)}
									>
										{row.read ? "Mark unread" : "Mark read"}
									</Button>
								) : null}
								{canDelete ? (
									<Button
										size="sm"
										variant="ghost"
										className="text-danger"
										disabled={pending}
										onClick={() => onDelete(row)}
									>
										{row.folder === "deleted" ? "Delete forever" : "Delete"}
									</Button>
								) : null}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	);
}

/**
 * Play one message through a URL minted on demand.
 *
 * The mint-on-press behaviour now lives in `MediaPreviewButton`, which four screens share — this
 * one, the hold-music files dialog, the prompt library and the greetings dialog. It was extracted
 * from here rather than the other way round, because this is where the reasoning was written down
 * and it applies unchanged to all four: never render a live credential for a row nobody played.
 *
 * What stays here is the part that is about VOICEMAIL specifically — the permission that gates
 * listening, and the sentence a row shows when the caller does not have it. `voicemail.listen` is
 * separate from `voicemail.read` on purpose (a supervisor may see that a message exists without
 * being entitled to hear it), so this is not a detail the shared button could infer.
 */
function MessagePlayer({
	boxId,
	message,
	canListen,
}: {
	boxId: string;
	message: VoicemailMessageRow;
	canListen: boolean;
}) {
	const mint = useVoicemailPlaybackUrl();

	if (!canListen) {
		return <span className="text-xs text-muted-foreground">No listen permission</span>;
	}

	return (
		<MediaPreviewButton
			mint={() => mint.mutateAsync({ boxId, messageId: message.id })}
			label={`Voicemail from ${new Date(message.receivedAt).toLocaleString()}`}
			failureMessage="This message could not be prepared for playback."
		/>
	);
}
