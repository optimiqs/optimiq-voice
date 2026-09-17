"use client";

import { useId, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/field";
import { formatBytes } from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { resolveComposerState } from "~/lib/messaging/composer";
import { messagingToastMessage, readSendBlock } from "~/lib/messaging/errors";
import { useSendMessage, useUploadMessagingMedia } from "../../_hooks/use-messaging-queries";
import type { MediaUploadResult } from "~/lib/messaging/contracts";
import type { SendBlock } from "~/lib/messaging/errors";

/**
 * The composer, and the three sentences that are the point of this whole feature.
 *
 * A send can be refused for a reason no client can compute: the number is not registered with the
 * carriers, the recipient replied STOP, or the campaign's quiet hours are in force. Each of those
 * comes back as a code and a SENTENCE — which number, which campaign, which clock — and this
 * component's most important job is to render that sentence unchanged and leave it on screen.
 *
 * ## Why the block latches
 *
 * The refusal is a fact about this recipient on this number, not about this click, so it stays
 * until one of those changes. Clearing it when the user types would produce a composer that opens
 * and closes as they edit, and would let them press send four times against a suppression list
 * that is not going to move. `resetKey` is what clears it: the parent passes the conversation id,
 * so switching threads asks again and staying put does not.
 *
 * ## Attachments are uploaded BEFORE the send, deliberately
 *
 * `POST media` answers with an `objectKey`, and only then does the send name it in `mediaKeys`.
 * That is the API's shape, and it is the right one for a UI too: a 12 MB image that the platform
 * will refuse fails while the operator is still holding the file, not after they have written a
 * paragraph.
 */
export function MessageComposer({
	messagingNumberId,
	to,
	resetKey,
	canSend,
	disabledReason,
}: {
	messagingNumberId: string | undefined;
	to: string | undefined;
	/** Changing this clears a latched refusal — the parent passes the conversation id. */
	resetKey: string;
	canSend: boolean;
	/** A refusal already known before any send — an opted-out thread, say. */
	disabledReason?: SendBlock | undefined;
}) {
	const textareaId = useId();
	const fileInput = useRef<HTMLInputElement>(null);
	const send = useSendMessage();
	const upload = useUploadMessagingMedia();

	const [body, setBody] = useState("");
	const [attachments, setAttachments] = useState<readonly MediaUploadResult[]>([]);
	const [block, setBlock] = useState<SendBlock | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [seenKey, setSeenKey] = useState(resetKey);

	/**
	 * Derived reset rather than an effect: switching threads must clear the draft and the refusal in
	 * the SAME render the new thread is drawn in, or the composer briefly shows the previous
	 * recipient's block above the new recipient's name.
	 */
	if (seenKey !== resetKey) {
		setSeenKey(resetKey);
		setBody("");
		setAttachments([]);
		setBlock(undefined);
		setFailure(undefined);
	}

	const state = resolveComposerState({
		block: block ?? disabledReason,
		canSendPermission: canSend,
		hasNumber: messagingNumberId !== undefined,
		hasRecipient: to !== undefined,
		bodyLength: body.trim().length,
		attachmentCount: attachments.length,
		sending: send.isPending || upload.isPending,
	});

	const submit = (): void => {
		if (!state.canSend || messagingNumberId === undefined || to === undefined) {
			return;
		}
		setFailure(undefined);
		send.mutate(
			{
				messagingNumberId,
				to,
				body: body.trim(),
				mediaKeys: attachments.map((attachment) => attachment.objectKey),
			},
			{
				onSuccess: () => {
					setBody("");
					setAttachments([]);
				},
				onError: (error) => {
					const refusal = readSendBlock(error);
					if (refusal) {
						setBlock(refusal);
						return;
					}
					/**
					 * Everything else stays as a retryable message above the box rather than latching it
					 * shut: a carrier timeout is not a policy, and the next attempt may well work.
					 */
					setFailure(messagingToastMessage(error, "That message could not be sent. Try again."));
				},
			},
		);
	};

	const attach = (file: File | undefined): void => {
		if (!file) {
			return;
		}
		upload.mutate(file, {
			onSuccess: (result) => {
				setAttachments((current) => [...current, result]);
			},
		});
		if (fileInput.current) {
			fileInput.current.value = "";
		}
	};

	return (
		<div className="flex flex-col gap-3 border-t border-border bg-surface px-4 py-3">
			{/* `<output>` carries an implicit role="status", so the refusal is announced rather than
			    only drawn — the whole point of it is that somebody learns why the send did not go. */}
			{state.message.length > 0 ? (
				<output
					className={cn(
						"block rounded-field border px-3 py-2",
						state.reason === "policy"
							? "border-danger/40 bg-danger-subtle"
							: "border-border bg-muted/40",
					)}
				>
					<p
						className={cn(
							"text-sm font-medium",
							state.reason === "policy" ? "text-danger" : "text-foreground",
						)}
					>
						{state.title}
					</p>
					{/* The server's own sentence, verbatim. Nothing between the wire and here rewrites it. */}
					<p className="mt-0.5 text-sm text-muted-foreground">{state.message}</p>
				</output>
			) : null}

			{failure ? (
				<p role="alert" className="text-sm text-danger">
					{failure}
				</p>
			) : null}

			{attachments.length > 0 ? (
				<ul className="flex flex-wrap gap-2">
					{attachments.map((attachment) => (
						<li key={attachment.objectKey}>
							<Badge tone="neutral" className="gap-2">
								{attachment.contentType} · {formatBytes(attachment.sizeBytes)}
								<button
									type="button"
									aria-label={`Remove attachment ${attachment.objectKey}`}
									className="text-muted-foreground hover:text-foreground"
									onClick={() =>
										setAttachments((current) =>
											current.filter((entry) => entry.objectKey !== attachment.objectKey),
										)
									}
								>
									×
								</button>
							</Badge>
						</li>
					))}
				</ul>
			) : null}

			<label htmlFor={textareaId} className="sr-only">
				Message
			</label>
			<Textarea
				id={textareaId}
				rows={3}
				value={body}
				onChange={(event) => setBody(event.target.value)}
				disabled={state.disabled}
				placeholder={state.disabled ? "Sending is not available on this thread" : "Write a message"}
				/**
				 * Enter sends and Shift+Enter breaks the line — the convention every messaging client
				 * shares, and getting it backwards is the single most irritating way a composer can be
				 * wrong.
				 */
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
				}}
			/>

			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<input
						ref={fileInput}
						type="file"
						className="sr-only"
						aria-label="Attach a file"
						onChange={(event) => attach(event.target.files?.[0])}
					/>
					<Button
						size="sm"
						variant="secondary"
						disabled={state.disabled}
						loading={upload.isPending}
						onClick={() => fileInput.current?.click()}
					>
						Attach
					</Button>
					<span className="text-xs text-muted-foreground">
						{body.trim().length > 0 ? `${String(body.trim().length)} characters` : "Enter to send"}
					</span>
				</div>
				<Button
					variant="primary"
					disabled={!state.canSend}
					loading={send.isPending}
					onClick={submit}
				>
					Send
				</Button>
			</div>
		</div>
	);
}
