"use client";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { LoadingPanel } from "~/components/ui/spinner";
import { cn } from "~/lib/cn";
import { conversationTitle, formatE164, messageStatusPresentation } from "~/lib/messaging/format";
import { MessageComposer } from "./message-composer";
import { MessageMedia } from "./message-media";
import type { ConversationRow, MessageRow } from "~/lib/messaging/contracts";

/**
 * The right-hand pane: one thread, oldest at the top, and the composer under it.
 *
 * ## Inbound and outbound are told apart three ways, not one
 *
 * Side, colour and a label. Colour alone fails for a colour-blind reader and side alone fails in
 * the narrow layout where both columns are the same width; the `sr-only` direction word is what
 * makes the thread readable to somebody who is hearing it rather than seeing it.
 *
 * ## `errorReason` is never swallowed
 *
 * A failed message carries the carrier's own sentence about why, and that sentence is usually the
 * ONLY explanation for a message that was silently filtered. It is rendered under the bubble in
 * full — not truncated, not behind a tooltip, not replaced with "failed".
 */
export function ThreadView({
	conversation,
	messages,
	isPending,
	messagingNumberId,
	localE164,
	canSend,
	onArchiveToggle,
	archivePending,
}: {
	conversation: ConversationRow | undefined;
	messages: readonly MessageRow[];
	isPending: boolean;
	messagingNumberId: string | undefined;
	localE164: string | undefined;
	canSend: boolean;
	onArchiveToggle: () => void;
	archivePending: boolean;
}) {
	if (!conversation) {
		return (
			<div className="flex min-h-64 flex-1 items-center justify-center rounded-panel border border-border bg-surface">
				<EmptyState
					className="border-0 bg-transparent"
					title="No conversation selected"
					description="Pick a thread on the left to read it and reply. Threads are per number, so the reply always goes out from the number the customer wrote to."
				/>
			</div>
		);
	}

	return (
		<section className="flex min-h-0 flex-1 flex-col rounded-panel border border-border bg-surface">
			<header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
				<div className="flex min-w-0 flex-col">
					<h2 className="truncate text-sm font-semibold text-foreground">
						{conversationTitle(conversation)}
					</h2>
					<p className="text-xs text-muted-foreground" data-tabular>
						{formatE164(conversation.remoteE164)}
						{localE164 ? ` · on ${formatE164(localE164)}` : ""}
					</p>
				</div>
				<Button size="sm" variant="secondary" loading={archivePending} onClick={onArchiveToggle}>
					{conversation.archived ? "Move to inbox" : "Archive"}
				</Button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
				{isPending ? (
					<LoadingPanel label="Loading messages" />
				) : messages.length === 0 ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						Nothing has been sent on this thread yet.
					</p>
				) : (
					messages.map((message) => <MessageBubble key={message.id} message={message} />)
				)}
			</div>

			<MessageComposer
				messagingNumberId={messagingNumberId}
				to={conversation.remoteE164}
				resetKey={conversation.id}
				canSend={canSend}
			/>
		</section>
	);
}

function MessageBubble({ message }: { message: MessageRow }) {
	const outbound = message.direction === "outbound";
	const status = messageStatusPresentation(message.status);

	return (
		<article className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
			<span className="sr-only">{outbound ? "Sent" : "Received"}</span>
			<div
				className={cn(
					"max-w-[min(36rem,85%)] rounded-panel px-3 py-2 text-sm",
					outbound
						? "bg-primary text-primary-foreground"
						: "border border-border bg-muted text-foreground",
				)}
			>
				{message.body ? <p className="break-words whitespace-pre-wrap">{message.body}</p> : null}
				{message.media.length > 0 ? (
					<ul className={cn("flex flex-col gap-2", message.body ? "mt-2" : "")}>
						{message.media.map((part) => (
							<li key={part.objectKey}>
								<MessageMedia messageId={message.id} part={part} />
							</li>
						))}
					</ul>
				) : null}
			</div>

			<div className="flex items-center gap-2">
				<span className="text-xs text-subtle-foreground" data-tabular>
					{new Date(message.createdAt).toLocaleString()}
				</span>
				{/* Only outbound messages have a delivery lifecycle worth reporting. */}
				{outbound ? <Badge tone={status.tone}>{status.label}</Badge> : null}
			</div>

			{message.status === "failed" && message.errorReason ? (
				<p
					role="alert"
					className="max-w-[min(36rem,85%)] text-xs text-danger"
					/**
					 * In full. This sentence is the carrier's, and it is usually the only thing that
					 * explains a message a spam filter took — truncating it would leave an operator with
					 * "failed" and nowhere to go.
					 */
				>
					{message.errorReason}
				</p>
			) : null}
		</article>
	);
}
