"use client";

import { useId, useRef, useState } from "react";
import { MediaPreviewButton } from "~/components/pbx/media-preview-button";
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
import { inputClassName } from "~/components/ui/field";
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
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { pbxFormMessage } from "~/lib/pbx/errors";
import { usePermission } from "../../_context/session-context";
import {
	useMohFileDelete,
	useMohFileUpload,
	useMohFiles,
	usePromptPlaybackUrl,
} from "../../_hooks/use-media-queries";
import type { MohClassRow, PromptRow } from "~/lib/pbx/contracts";

/**
 * The audio inside one hold-music class.
 *
 * ## Why a dialog, and why a raw one
 *
 * The same reasoning the mailbox message list writes down: this is a thing you open, act on and
 * close. It is not linkable, not a route anybody would share, and not a form — so it is neither a
 * page nor an `EntityFormDialog`, which owns a `<form>`, a submit button and a save/cancel footer
 * that would all be wrong here. There is no "save": each upload and each removal is its own write,
 * committed the moment it is made, and the footer's only job is to close.
 *
 * ## Why the failure is under the file input rather than in a toast
 *
 * An upload is refused for reasons that take a sentence to say and an action to fix — the bytes are
 * not audio the media server can play (the API checks MAGIC BYTES, not just the declared type, so a
 * renamed file is caught), the file is over the size cap, the name collides. `useMohFileUpload`
 * deliberately does not raise a toast for that, and this is the reason: a four-second banner is the
 * wrong container for a message somebody has to read twice and then act on. Removal failures DO
 * toast, because the hook raises one — a removal is refused only by a reference guard, and that
 * message is complete on its own.
 *
 * ## Why the list is not paginated
 *
 * `/moh-classes/:id/files` is not paginated by the API, and that is a deliberate ceiling rather
 * than an oversight: a hold-music playlist with more than a screenful of tracks is a class that
 * wants splitting, not a list that wants pages.
 */
export function MohFilesDialog({
	open,
	onOpenChange,
	mohClass,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly mohClass: MohClassRow | null;
}) {
	const fileInputId = useId();
	const nameInputId = useId();
	const fileInputRef = useRef<HTMLInputElement>(null);

	const [file, setFile] = useState<File | null>(null);
	const [name, setName] = useState("");

	// From the descriptor, not a literal: files are written under the class's own grant.
	const canWrite = usePermission(PBX_RESOURCES.mohClasses.permissions.write);

	const files = useMohFiles(open && mohClass !== null ? mohClass.id : null);
	const upload = useMohFileUpload();
	const remove = useMohFileDelete();

	const uploadError =
		upload.error === null || upload.error === undefined ? undefined : pbxFormMessage(upload.error);

	const resetUploadForm = (): void => {
		setFile(null);
		setName("");
		upload.reset();
		if (fileInputRef.current !== null) {
			fileInputRef.current.value = "";
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[calc(100dvh-3rem)] w-[min(48rem,calc(100vw-2rem))] flex-col">
				<DialogHeader>
					<DialogTitle>
						{mohClass === null ? "Hold music files" : `Files in ${mohClass.name}`}
					</DialogTitle>
					<DialogDescription>
						{mohClass?.source === "stream"
							? "This class pulls a stream, so these files are never played. They are kept in case the class is switched back to the library."
							: "Played to anyone on hold in this class. Previews are signed links that expire within minutes."}
					</DialogDescription>
				</DialogHeader>

				{canWrite ? (
					<form
						noValidate
						className="mb-3 flex flex-col gap-2 rounded-panel border border-border bg-surface/50 p-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (mohClass === null || file === null) {
								return;
							}
							upload.mutate(
								{ mohClassId: mohClass.id, file, ...(name === "" ? {} : { name }) },
								{ onSuccess: resetUploadForm },
							);
						}}
					>
						<div className="flex flex-wrap items-end gap-3">
							<div className="flex min-w-56 flex-1 flex-col gap-1.5">
								<label htmlFor={fileInputId} className="text-xs font-medium text-muted-foreground">
									Audio file
								</label>
								<input
									id={fileInputId}
									ref={fileInputRef}
									type="file"
									/*
									 * A hint, never a guarantee. The browser's file picker filters on this, and
									 * the server checks the magic bytes regardless — a renamed executable
									 * declaring `audio/wav` gets past every check a browser can make.
									 */
									accept=".wav,.mp3,audio/wav,audio/mpeg"
									disabled={upload.isPending}
									onChange={(event) => {
										setFile(event.target.files?.[0] ?? null);
										upload.reset();
									}}
									className={cn(inputClassName, "h-auto py-1.5 file:mr-3 file:text-sm")}
									aria-describedby={uploadError === undefined ? undefined : `${fileInputId}-error`}
									aria-invalid={uploadError === undefined ? undefined : true}
								/>
							</div>
							<div className="flex min-w-44 flex-col gap-1.5">
								<label htmlFor={nameInputId} className="text-xs font-medium text-muted-foreground">
									Name (optional)
								</label>
								<input
									id={nameInputId}
									type="text"
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder="Taken from the file name"
									disabled={upload.isPending}
									className={inputClassName}
								/>
							</div>
							<Button
								type="submit"
								variant="primary"
								loading={upload.isPending}
								disabled={mohClass === null || file === null}
							>
								Upload
							</Button>
						</div>
						{uploadError === undefined ? null : (
							<p id={`${fileInputId}-error`} role="alert" className="text-xs text-danger">
								{uploadError}
							</p>
						)}
					</form>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto">
					<MohFilesTable
						mohClassId={mohClass?.id ?? ""}
						rows={files.data ?? []}
						isPending={files.isPending}
						canWrite={canWrite}
						pending={remove.isPending}
						onRemove={(row) => {
							if (mohClass !== null) {
								remove.mutate({ mohClassId: mohClass.id, fileId: row.id });
							}
						}}
					/>
				</div>

				<DialogFooter>
					<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MohFilesTable({
	mohClassId,
	rows,
	isPending,
	canWrite,
	pending,
	onRemove,
}: {
	readonly mohClassId: string;
	readonly rows: readonly PromptRow[];
	readonly isPending: boolean;
	readonly canWrite: boolean;
	readonly pending: boolean;
	readonly onRemove: (row: PromptRow) => void;
}) {
	if (mohClassId === "") {
		return null;
	}
	if (isPending) {
		return <LoadingPanel label="Loading files" />;
	}
	if (rows.length === 0) {
		return (
			<EmptyState
				title="Nothing uploaded yet"
				description="Upload the audio this class should play. Anyone put on hold under it hears silence until something is here."
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Audio files in this hold-music class</caption>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead className="text-right">Length</TableHead>
						<TableHead className="text-right">Size</TableHead>
						<TableHead>Audio</TableHead>
						<TableHead className="w-0">
							<span className="sr-only">Actions</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id}>
							<TableCell className="font-medium">
								<div className="flex flex-col">
									<span>{row.name}</span>
									<span className="text-xs text-muted-foreground">{row.contentType}</span>
								</div>
							</TableCell>
							<TableCell className="text-right whitespace-nowrap" data-tabular>
								{row.durationMs === null ? "—" : formatDuration(row.durationMs)}
							</TableCell>
							<TableCell className="text-right whitespace-nowrap" data-tabular>
								{row.sizeBytes === null ? "—" : formatBytes(row.sizeBytes)}
							</TableCell>
							<TableCell>
								<MohFilePlayer file={row} />
							</TableCell>
							<TableCell className="text-right whitespace-nowrap">
								{canWrite ? (
									<Button
										size="sm"
										variant="ghost"
										className="text-danger"
										disabled={pending}
										onClick={() => onRemove(row)}
									>
										Remove
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
 * One row's preview.
 *
 * A component per row rather than one mint mutation for the table, so a press on the third row does
 * not put the other nineteen into "Preparing…". A hold-music file is a `prompt` row, which is why
 * the prompt endpoint mints its link — there is no separate MOH playback route and there should not
 * be one.
 */
function MohFilePlayer({ file }: { readonly file: PromptRow }) {
	const mint = usePromptPlaybackUrl();

	return (
		<MediaPreviewButton
			mint={() => mint.mutateAsync(file.id)}
			label={file.name}
			failureMessage="This file could not be prepared for playback."
		/>
	);
}
