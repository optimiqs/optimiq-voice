"use client";

import { useForm } from "@tanstack/react-form";
import { useId, useRef, useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { MediaPreviewButton } from "~/components/pbx/media-preview-button";
import { ListPagination, ResourceTable, useListQueryState } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { inputClassName } from "~/components/ui/field";
import { TextField } from "~/components/ui/form-fields";
import { formatBytes, formatDuration } from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import {
	promptFormSchema,
	promptUploadFormSchema,
	type PromptFormValues,
	type PromptUploadFormValues,
} from "~/lib/pbx/schemas";
import { usePermission } from "../../_context/session-context";
import {
	usePromptDelete,
	usePromptList,
	usePromptPlaybackUrl,
	usePromptUpdate,
	usePromptUpload,
} from "../../_hooks/use-media-queries";
import type { PromptRow } from "~/lib/pbx/contracts";

/**
 * The prompt library: every stored recording an IVR, an announcement or a queue can point at.
 *
 * ## Why this list is not `usePbxList`
 *
 * `PBX_RESOURCES.prompts` is a perfectly ordinary descriptor and the edit and delete paths use the
 * generic hooks through it. The LIST is the exception, because `/prompts` takes filters the generic
 * `PbxListQuery` has no vocabulary for — `kind` and `mohClassId` — and widening the shared query
 * type for one caller would put two dead parameters on every other resource's list.
 *
 * No `kind` is sent, which is not the same as "everything": the API reads an absent `kind` as the
 * two kinds a prompt PICKER can offer, `prompt` and `greeting`, and never MOH files. Those are
 * reached through their class, where they mean something. Greetings show here because they are
 * library objects like any other and hiding them would make an upload disappear; the kind is named
 * under the row's name so a row that came from a mailbox is not mistaken for an announcement.
 *
 * ## Why the state filter is missing from the toolbar
 *
 * `prompt` has no `enabled` column — a stored object is either there or it is not — so the shared
 * `ListToolbar` would offer a control that does nothing. The list STATE still comes from
 * `useListQueryState`, for its URL keys and its search debounce, and only the search half of it is
 * rendered.
 *
 * ## Why replacing the audio is not an edit
 *
 * The edit form has two fields, and that is the whole editable surface. `objectKey`, `contentType`,
 * `sizeBytes` and `checksum` are facts about the bytes that were actually stored, and the API
 * refuses them in a `PATCH` — accepting an object key from a client would let one tenant's row be
 * re-pointed at another tenant's file by editing a string. Replacing a recording is a new upload,
 * because the old object key may already be inside a compiled artifact and inside a live call.
 */
export function PromptsPanel() {
	// Prefixed, because the hold-music tab's list state shares this URL.
	const { query, search, setSearch, page, setPage } = useListQueryState("pr");

	const searchId = useId();

	const list = usePromptList({
		page: query.page ?? 1,
		limit: DEFAULT_PAGE_LIMIT,
		search: query.search,
	});
	const remove = usePromptDelete();

	// From the descriptor rather than a literal, so this screen and the endpoint behind it cannot
	// come to disagree about which grant a write needs.
	const canWrite = usePermission(PBX_RESOURCES.prompts.permissions.write);
	const canDelete = usePermission(PBX_RESOURCES.prompts.permissions.delete);

	const [uploadOpen, setUploadOpen] = useState(false);
	const [editing, setEditing] = useState<PromptRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<PromptRow | null>(null);

	const rows = list.data?.data ?? [];
	const total = list.data?.total ?? 0;
	const totalPages = list.data?.totalPages ?? 0;

	const uploadButton = canWrite ? (
		<Button variant="primary" onClick={() => setUploadOpen(true)}>
			Upload
		</Button>
	) : null;

	return (
		<>
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-56 flex-1 flex-col gap-1.5">
					<label htmlFor={searchId} className="text-xs font-medium text-muted-foreground">
						Search
					</label>
					<input
						id={searchId}
						type="search"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Prompt name"
						className={inputClassName}
					/>
				</div>
				{uploadButton ? <div className="ml-auto">{uploadButton}</div> : null}
			</div>

			<ResourceTable
				rows={rows}
				isPending={list.isPending}
				filtered={search.length > 0}
				emptyTitle="No prompts yet"
				emptyDescription="A prompt is a recording an IVR, an announcement or a queue plays. Upload the audio and it becomes selectable everywhere a recording can be chosen."
				emptyAction={uploadButton}
				caption="Stored prompts in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<div className="flex flex-col">
								<span>{row.name}</span>
								<span className="text-xs text-muted-foreground">
									{row.kind === "greeting" ? "Mailbox greeting · " : ""}
									{row.contentType}
								</span>
							</div>
						),
					},
					{
						key: "language",
						header: "Language",
						className: "whitespace-nowrap",
						cell: (row) => <Badge tone="neutral">{row.language}</Badge>,
					},
					{
						key: "durationMs",
						header: "Length",
						headerClassName: "text-right",
						className: "text-right whitespace-nowrap",
						cell: (row) => (
							<span data-tabular>
								{row.durationMs === null ? "—" : formatDuration(row.durationMs)}
							</span>
						),
					},
					{
						key: "sizeBytes",
						header: "Size",
						headerClassName: "text-right",
						className: "text-right whitespace-nowrap",
						cell: (row) => (
							<span data-tabular>{row.sizeBytes === null ? "—" : formatBytes(row.sizeBytes)}</span>
						),
					},
					{ key: "audio", header: "Audio", cell: (row) => <PromptPlayer prompt={row} /> },
				]}
				rowActions={(row) => (
					<RowActions
						label={`prompt ${row.name}`}
						onEdit={canWrite ? () => setEditing(row) : undefined}
						onDelete={
							canDelete
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={page}
				limit={DEFAULT_PAGE_LIMIT}
				total={total}
				totalPages={totalPages}
				onPageChange={setPage}
			/>

			<PromptUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />

			<PromptEditDialog
				key={editing?.id ?? "none"}
				open={editing !== null}
				onOpenChange={(open) => {
					if (!open) {
						setEditing(null);
					}
				}}
				prompt={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="prompt"
				entityName={pendingDelete ? pendingDelete.name : "this prompt"}
				description="The row and the stored audio are both removed. Eight things can point at a prompt — an IVR's greeting, an announcement, a queue's periodic message among them — and the delete is refused while any of them still does, with the referrers named."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}

/** One row's preview. A mint mutation per row, so pressing one does not busy the other nineteen. */
function PromptPlayer({ prompt }: { readonly prompt: PromptRow }) {
	const mint = usePromptPlaybackUrl();

	return (
		<MediaPreviewButton
			mint={() => mint.mutateAsync(prompt.id)}
			label={prompt.name}
			failureMessage="This prompt could not be prepared for playback."
		/>
	);
}

/**
 * Uploading a recording into the library.
 *
 * A `<form>` with a file input rather than a drop zone, because this is a once-a-quarter action and
 * a file input is the control every assistive technology and every keyboard already knows. The name
 * and language are optional: the server derives both from the file when they are absent, and
 * demanding them up front turns a two-click task into a form.
 *
 * The file itself lives in local state rather than in the form. TanStack Form would hold it
 * perfectly well, but the schema is Zod and a `File` is not something a Zod schema in a shared
 * `schemas.ts` should have to model — `promptUploadFormSchema` therefore covers the two text fields
 * and the file is validated by the only authority that can validate it, which is the server reading
 * its magic bytes.
 */
function PromptUploadDialog({
	open,
	onOpenChange,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	const fileInputId = useId();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string | undefined>(undefined);

	const upload = usePromptUpload();
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: { name: "", language: "" } satisfies PromptUploadFormValues,
		validators: { onSubmit: promptUploadFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = promptUploadFormSchema.parse(value);
			server.clear();

			if (file === null) {
				setFileError("Choose an audio file to upload.");
				return;
			}
			setFileError(undefined);

			try {
				await upload.mutateAsync({
					file,
					...(parsed.name === null ? {} : { name: parsed.name }),
					...(parsed.language === "" ? {} : { language: parsed.language }),
				});
				reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	function reset(): void {
		setFile(null);
		setFileError(undefined);
		server.clear();
		upload.reset();
		form.reset();
		if (fileInputRef.current !== null) {
			fileInputRef.current.value = "";
		}
	}

	// The server addresses an upload refusal at `file`; anything else falls through to the banner.
	const shownFileError = fileError ?? server.errors.file;

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					reset();
				}
				onOpenChange(next);
			}}
			title="Upload a prompt"
			description="Audio the phone system can play. WAV or MP3 — the server checks the bytes, not the file name."
			submitLabel="Upload"
			pending={upload.isPending}
			error={upload.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<FormSection title="Audio" columns={1}>
				<div className="flex flex-col gap-1.5">
					<label htmlFor={fileInputId} className="text-sm font-medium text-foreground">
						File
						<span aria-hidden="true" className="ml-0.5 text-danger">
							*
						</span>
					</label>
					<input
						id={fileInputId}
						ref={fileInputRef}
						type="file"
						accept=".wav,.mp3,audio/wav,audio/mpeg"
						disabled={upload.isPending}
						onChange={(event) => {
							setFile(event.target.files?.[0] ?? null);
							setFileError(undefined);
						}}
						className={cn(inputClassName, "h-auto py-1.5 file:mr-3 file:text-sm")}
						aria-required="true"
						aria-invalid={shownFileError === undefined ? undefined : true}
						aria-describedby={
							shownFileError === undefined ? `${fileInputId}-help` : `${fileInputId}-error`
						}
					/>
					{shownFileError === undefined ? (
						<p id={`${fileInputId}-help`} className="text-xs text-muted-foreground">
							A renamed file is refused: the server reads the magic bytes rather than trusting the
							extension or the declared type.
						</p>
					) : (
						<p id={`${fileInputId}-error`} role="alert" className="text-xs text-danger">
							{shownFileError}
						</p>
					)}
				</div>
			</FormSection>

			<FormSection title="Details">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							placeholder="Taken from the file name"
							disabled={upload.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="language">
					{(field) => (
						<TextField
							field={field}
							label="Language"
							placeholder="en-US"
							description="A BCP 47 tag. Left blank, the server uses the organization's default."
							disabled={upload.isPending}
							submitError={server.errors.language}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

/**
 * Renaming a prompt, and nothing else.
 *
 * Two fields is not a placeholder for a fuller form. See the panel's note: everything else on a
 * `prompt` row describes the bytes that were stored, and the API refuses all of it in a `PATCH`.
 */
function PromptEditDialog({
	open,
	onOpenChange,
	prompt,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly prompt: PromptRow | null;
}) {
	const update = usePromptUpdate();
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: {
			name: prompt?.name ?? "",
			language: prompt?.language ?? "",
		} satisfies PromptFormValues,
		validators: { onSubmit: promptFormSchema },
		onSubmit: async ({ value }) => {
			if (prompt === null) {
				return;
			}
			const parsed = promptFormSchema.parse(value);
			server.clear();

			try {
				await update.mutateAsync({
					promptId: prompt.id,
					name: parsed.name,
					language: parsed.language,
				});
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					server.clear();
					update.reset();
					form.reset();
				}
				onOpenChange(next);
			}}
			title={prompt === null ? "Edit prompt" : `Edit ${prompt.name}`}
			description="The name and the language tag. The audio itself is replaced by uploading a new prompt."
			submitLabel="Save changes"
			pending={update.isPending}
			error={update.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote={
				prompt === null
					? undefined
					: `Stored as ${prompt.objectKey}. That key is what a compiled dial plan and a call in progress are holding, which is why it cannot be edited.`
			}
		>
			<FormSection title="Prompt">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus
							disabled={update.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="language">
					{(field) => (
						<TextField
							field={field}
							label="Language"
							required
							placeholder="en-US"
							description="A BCP 47 tag, e.g. en-US or fr."
							disabled={update.isPending}
							submitError={server.errors.language}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
