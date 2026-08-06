"use client";

import { useId, useRef, useState } from "react";
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
import { inputClassName } from "~/components/ui/field";
import { LoadingPanel } from "~/components/ui/spinner";
import { formatDuration } from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { VOICEMAIL_GREETING_KINDS } from "~/lib/pbx/contracts";
import { pbxFormMessage } from "~/lib/pbx/errors";
import { greetingUploadFormSchema } from "~/lib/pbx/schemas";
import { usePermission } from "../../_context/session-context";
import {
	useGreetingActivation,
	useGreetingDelete,
	useGreetingPlaybackUrl,
	useGreetingUpload,
	useVoicemailGreetings,
} from "../../_hooks/use-media-queries";
import type {
	VoicemailBoxRow,
	VoicemailGreetingKind,
	VoicemailGreetingRow,
} from "~/lib/pbx/contracts";

/**
 * The greetings on one mailbox.
 *
 * ## Why the list is grouped by kind rather than sorted flat
 *
 * A mailbox has four SLOTS, not a pile of recordings: the caller hears the `unavailable` greeting
 * when nobody answers, `busy` when the extension is engaged, `name` in the middle of a system
 * announcement, and `temporary` overrides the first two while it is active. Several recordings can
 * exist per slot and exactly one of them per slot is live — activating one stands the incumbent
 * down in the same transaction on the server. A flat list sorted by upload date would render that
 * structure invisible, and "why is my new greeting not playing" is the question it would produce.
 *
 * Every slot is shown, including the empty ones, because an absent greeting is a real and important
 * state: the mailbox falls back to the system's own recording, which says a mailbox number rather
 * than a person's name.
 *
 * ## Why a greeting write invalidates the compile view and a prompt upload does not
 *
 * `voicemail_greeting` IS a routing input. The compiled artifact carries the ACTIVE greeting's
 * object key as `object://<key>`, so uploading, activating, standing down or deleting one changes
 * what a caller hears and the compile banner has to notice. `prompt` is deliberately not in that
 * map. `use-media-queries.ts` owns both rules; this dialog only has to know that a change here is
 * consequential enough to be worth a confirmation-free, immediate write.
 *
 * ## Why the upload defaults to "make active now"
 *
 * Somebody uploading a greeting is almost always replacing the one that is playing. Making them
 * upload and then activate turns one intention into two steps, and the step people forget is the
 * second — which leaves a mailbox playing the old recording with the new one sitting next to it
 * looking done. The checkbox is there for the case that is genuinely staged (recording next
 * month's holiday message in advance), which is the rarer one.
 */
const KIND_LABELS: Readonly<Record<VoicemailGreetingKind, string>> = {
	unavailable: "Unavailable",
	busy: "Busy",
	name: "Recorded name",
	temporary: "Temporary",
};

const KIND_DESCRIPTIONS: Readonly<Record<VoicemailGreetingKind, string>> = {
	unavailable: "Played when the call is not answered. The one most callers hear.",
	busy: "Played when the extension is already on a call.",
	name: "Spoken inside system announcements in place of the mailbox number.",
	temporary: "Overrides the unavailable and busy greetings while it is active.",
};

export function VoicemailGreetingsDialog({
	open,
	onOpenChange,
	box,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly box: VoicemailBoxRow | null;
}) {
	const fileInputId = useId();
	const kindInputId = useId();
	const labelInputId = useId();
	const activeInputId = useId();
	const fileInputRef = useRef<HTMLInputElement>(null);

	const [file, setFile] = useState<File | null>(null);
	const [kind, setKind] = useState<VoicemailGreetingKind>("unavailable");
	const [label, setLabel] = useState("");
	const [active, setActive] = useState(true);
	const [localError, setLocalError] = useState<string | null>(null);

	const canWrite = usePermission("voicemail.write");
	const canDelete = usePermission("voicemail.delete");
	const canListen = usePermission("voicemail.listen");

	const greetings = useVoicemailGreetings(open && box !== null ? box.id : null);
	const upload = useGreetingUpload();
	const activation = useGreetingActivation();
	const remove = useGreetingDelete();

	const rows = greetings.data ?? [];

	const uploadError =
		localError ??
		(upload.error === null || upload.error === undefined
			? undefined
			: pbxFormMessage(upload.error)) ??
		undefined;

	const resetUploadForm = (): void => {
		setFile(null);
		setLabel("");
		setLocalError(null);
		upload.reset();
		if (fileInputRef.current !== null) {
			fileInputRef.current.value = "";
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[calc(100dvh-3rem)] w-[min(52rem,calc(100vw-2rem))] flex-col">
				<DialogHeader>
					<DialogTitle>
						{box === null ? "Greetings" : `Greetings for mailbox ${box.mailboxNumber}`}
					</DialogTitle>
					<DialogDescription>
						Four slots, one active recording in each. A slot with nothing active falls back to the
						system greeting, which announces the mailbox number rather than a name.
					</DialogDescription>
				</DialogHeader>

				{canWrite ? (
					<form
						noValidate
						className="mb-3 flex flex-col gap-2 rounded-panel border border-border bg-surface/50 p-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (box === null) {
								return;
							}
							if (file === null) {
								setLocalError("Choose an audio file to upload.");
								return;
							}
							const parsed = greetingUploadFormSchema.safeParse({ kind, label, active });
							if (!parsed.success) {
								setLocalError(
									parsed.error.issues[0]?.message ?? "That greeting could not be uploaded.",
								);
								return;
							}
							setLocalError(null);
							upload.mutate(
								{
									boxId: box.id,
									file,
									kind: parsed.data.kind,
									active: parsed.data.active,
									...(parsed.data.label === null ? {} : { label: parsed.data.label }),
								},
								{ onSuccess: resetUploadForm },
							);
						}}
					>
						<div className="flex flex-wrap items-end gap-3">
							<div className="flex min-w-52 flex-1 flex-col gap-1.5">
								<label htmlFor={fileInputId} className="text-xs font-medium text-muted-foreground">
									Audio file
								</label>
								<input
									id={fileInputId}
									ref={fileInputRef}
									type="file"
									// A hint only. The server checks the magic bytes, which is the check that counts.
									accept=".wav,.mp3,audio/wav,audio/mpeg"
									disabled={upload.isPending}
									onChange={(event) => {
										setFile(event.target.files?.[0] ?? null);
										setLocalError(null);
										upload.reset();
									}}
									className={cn(inputClassName, "h-auto py-1.5 file:mr-3 file:text-sm")}
									aria-invalid={uploadError === undefined ? undefined : true}
									aria-describedby={uploadError === undefined ? undefined : `${fileInputId}-error`}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<label htmlFor={kindInputId} className="text-xs font-medium text-muted-foreground">
									Slot
								</label>
								<select
									id={kindInputId}
									value={kind}
									onChange={(event) => setKind(event.target.value as VoicemailGreetingKind)}
									disabled={upload.isPending}
									className={cn(inputClassName, "w-44 pr-8")}
								>
									{VOICEMAIL_GREETING_KINDS.map((value) => (
										<option key={value} value={value}>
											{KIND_LABELS[value]}
										</option>
									))}
								</select>
							</div>
							<div className="flex min-w-40 flex-col gap-1.5">
								<label htmlFor={labelInputId} className="text-xs font-medium text-muted-foreground">
									Label (optional)
								</label>
								<input
									id={labelInputId}
									type="text"
									value={label}
									onChange={(event) => setLabel(event.target.value)}
									placeholder="Holiday message"
									disabled={upload.isPending}
									className={inputClassName}
								/>
							</div>
							<Button
								type="submit"
								variant="primary"
								loading={upload.isPending}
								disabled={box === null || file === null}
							>
								Upload
							</Button>
						</div>
						<label htmlFor={activeInputId} className="flex items-center gap-2 text-xs">
							<input
								id={activeInputId}
								type="checkbox"
								checked={active}
								onChange={(event) => setActive(event.target.checked)}
								disabled={upload.isPending}
								className="size-3.5 accent-primary"
							/>
							<span className="text-muted-foreground">
								Make active now — replaces whatever is playing in this slot
							</span>
						</label>
						{uploadError === undefined ? null : (
							<p id={`${fileInputId}-error`} role="alert" className="text-xs text-danger">
								{uploadError}
							</p>
						)}
					</form>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto">
					{box === null ? null : greetings.isPending ? (
						<LoadingPanel label="Loading greetings" />
					) : rows.length === 0 ? (
						<EmptyState
							title="No greetings recorded"
							description="Every slot falls back to the system greeting, which announces the mailbox number. Upload a recording to replace it."
						/>
					) : (
						<div className="flex flex-col gap-5">
							{VOICEMAIL_GREETING_KINDS.map((slot) => (
								<GreetingSlot
									key={slot}
									boxId={box.id}
									slot={slot}
									rows={rows.filter((row) => row.kind === slot)}
									canWrite={canWrite}
									canDelete={canDelete}
									canListen={canListen}
									pending={activation.isPending || remove.isPending}
									onToggleActive={(row) => {
										activation.mutate({
											boxId: row.voicemailBoxId,
											greetingId: row.id,
											active: !row.active,
										});
									}}
									onDelete={(row) => {
										remove.mutate({ boxId: row.voicemailBoxId, greetingId: row.id });
									}}
								/>
							))}
						</div>
					)}
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

/**
 * One slot, with everything recorded for it.
 *
 * Rendered even when it holds nothing, because "this mailbox has no busy greeting" is the fact
 * somebody opening this dialog most often came to check.
 */
function GreetingSlot({
	boxId,
	slot,
	rows,
	canWrite,
	canDelete,
	canListen,
	pending,
	onToggleActive,
	onDelete,
}: {
	readonly boxId: string;
	readonly slot: VoicemailGreetingKind;
	readonly rows: readonly VoicemailGreetingRow[];
	readonly canWrite: boolean;
	readonly canDelete: boolean;
	readonly canListen: boolean;
	readonly pending: boolean;
	readonly onToggleActive: (row: VoicemailGreetingRow) => void;
	readonly onDelete: (row: VoicemailGreetingRow) => void;
}) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex flex-col gap-0.5">
				<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					{KIND_LABELS[slot]}
				</h3>
				<p className="text-xs text-muted-foreground">{KIND_DESCRIPTIONS[slot]}</p>
			</div>

			{rows.length === 0 ? (
				<p className="rounded-field border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
					Nothing recorded. Callers hear the system greeting for this slot.
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{rows.map((row) => (
						<li
							key={row.id}
							className="flex flex-wrap items-center gap-3 rounded-field border border-border bg-surface px-3 py-2"
						>
							<span className="min-w-0 flex-1 truncate text-sm">
								{row.label ?? `${KIND_LABELS[slot]} greeting`}
							</span>
							<span className="text-xs text-muted-foreground" data-tabular>
								{row.durationMs === null ? "—" : formatDuration(row.durationMs)}
							</span>
							{row.active ? <Badge tone="success">Active</Badge> : null}
							{canListen ? <GreetingPlayer boxId={boxId} greeting={row} slot={slot} /> : null}
							{canWrite ? (
								<Button
									size="sm"
									variant={row.active ? "ghost" : "secondary"}
									disabled={pending}
									onClick={() => onToggleActive(row)}
								>
									{row.active ? "Stand down" : "Activate"}
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
									Delete
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** A mint mutation per row, so pressing one row's Play does not busy the others. */
function GreetingPlayer({
	boxId,
	greeting,
	slot,
}: {
	readonly boxId: string;
	readonly greeting: VoicemailGreetingRow;
	readonly slot: VoicemailGreetingKind;
}) {
	const mint = useGreetingPlaybackUrl();

	return (
		<MediaPreviewButton
			mint={() => mint.mutateAsync({ boxId, greetingId: greeting.id })}
			label={greeting.label ?? `${KIND_LABELS[slot]} greeting`}
			failureMessage="This greeting could not be prepared for playback."
		/>
	);
}
