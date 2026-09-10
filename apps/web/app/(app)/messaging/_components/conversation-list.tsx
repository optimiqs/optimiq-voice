"use client";

import { useId } from "react";
import { ListPagination } from "~/components/pbx/resource-list";
import { Badge } from "~/components/ui/badge";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { focusRing } from "~/components/ui/focus-ring";
import { LoadingPanel } from "~/components/ui/spinner";
import { cn } from "~/lib/cn";
import { DEFAULT_CONVERSATION_LIMIT } from "~/lib/messaging/client";
import {
	conversationPreview,
	conversationTitle,
	relativeTime,
	unreadBadgeLabel,
} from "~/lib/messaging/format";
import type { ConversationRow } from "~/lib/messaging/contracts";

/**
 * The middle pane — every thread on the selected number, newest first.
 *
 * ## Why the rows are buttons and not links
 *
 * The selected thread IS in the URL (`?c=`), so a row could be an anchor — and is not, because
 * clicking one does not navigate anywhere a browser understands: the thread opens beside the list,
 * the list keeps its scroll position, and there is no page to open in a new tab that would be
 * different from this one. A `<button>` in a `<ul>` says exactly that, and `aria-current` is what
 * tells a screen reader which of them is showing.
 *
 * ## Search is server-side, and the empty state says which kind of empty it is
 *
 * "No conversations yet" and "nothing matched that search" send a reader to two different next
 * actions, so they are two different messages — the rule every list surface in this app follows.
 */
export function ConversationList({
	conversations,
	isPending,
	selectedId,
	onSelect,
	search,
	onSearchChange,
	archived,
	onArchivedChange,
	page,
	total,
	totalPages,
	onPageChange,
	hasNumber,
}: {
	conversations: readonly ConversationRow[];
	isPending: boolean;
	selectedId: string | undefined;
	onSelect: (conversation: ConversationRow) => void;
	search: string;
	onSearchChange: (value: string) => void;
	archived: boolean;
	onArchivedChange: (value: boolean) => void;
	page: number;
	total: number;
	totalPages: number;
	onPageChange: (page: number) => void;
	hasNumber: boolean;
}) {
	const searchId = useId();
	const filterId = useId();
	const filtered = search.length > 0;

	return (
		<div className="flex min-h-0 flex-col gap-3">
			<div className="flex flex-wrap items-end gap-2">
				<div className="flex min-w-40 flex-1 flex-col gap-1.5">
					<label htmlFor={searchId} className="text-xs font-medium text-muted-foreground">
						Search
					</label>
					<input
						id={searchId}
						type="search"
						value={search}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder="Number or name"
						className={inputClassName}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<label htmlFor={filterId} className="text-xs font-medium text-muted-foreground">
						Show
					</label>
					<select
						id={filterId}
						value={archived ? "archived" : "inbox"}
						onChange={(event) => onArchivedChange(event.target.value === "archived")}
						className={cn(inputClassName, "w-32 pr-8")}
					>
						<option value="inbox">Inbox</option>
						<option value="archived">Archived</option>
					</select>
				</div>
			</div>

			{isPending ? (
				<LoadingPanel label="Loading conversations" />
			) : conversations.length === 0 ? (
				<EmptyState
					title={
						filtered
							? "Nothing matched"
							: hasNumber
								? archived
									? "Nothing archived"
									: "No conversations yet"
								: "No messaging numbers"
					}
					description={
						filtered
							? "No conversation on this number matches that search. Clear it to see everything."
							: hasNumber
								? archived
									? "Threads you archive are kept here, and a new inbound message brings one back to the inbox."
									: "A thread appears the moment somebody texts this number, or the moment somebody here sends the first message."
								: "Enable messaging on one of this organization's phone numbers under Settings → Messaging, and its threads appear here."
					}
				/>
			) : (
				<ul className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-panel border border-border bg-surface">
					{conversations.map((conversation) => {
						const selected = conversation.id === selectedId;
						const unread = unreadBadgeLabel(conversation.unreadCount);

						return (
							<li key={conversation.id} className="border-b border-border last:border-0">
								<button
									type="button"
									aria-current={selected ? "true" : undefined}
									onClick={() => onSelect(conversation)}
									className={cn(
										"flex w-full flex-col gap-1 px-4 py-3 text-left",
										"transition-colors duration-[--motion-fast] hover:bg-hover",
										selected && "bg-accent",
										focusRing,
									)}
								>
									<span className="flex items-baseline justify-between gap-2">
										<span
											className={cn(
												"min-w-0 truncate text-sm text-foreground",
												conversation.unreadCount > 0 ? "font-semibold" : "font-medium",
											)}
										>
											{conversationTitle(conversation)}
										</span>
										<span
											className="shrink-0 text-xs text-muted-foreground"
											data-tabular
											title={
												conversation.lastMessageAt
													? new Date(conversation.lastMessageAt).toLocaleString()
													: undefined
											}
										>
											{relativeTime(conversation.lastMessageAt)}
										</span>
									</span>
									<span className="flex items-center justify-between gap-2">
										<span
											className={cn(
												"min-w-0 truncate text-xs",
												conversation.unreadCount > 0 ? "text-foreground" : "text-muted-foreground",
											)}
										>
											{conversationPreview(conversation)}
										</span>
										{unread.length > 0 ? (
											<Badge tone="accent" aria-label={`${unread} unread`}>
												{unread}
											</Badge>
										) : null}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}

			<ListPagination
				page={page}
				limit={DEFAULT_CONVERSATION_LIMIT}
				total={total}
				totalPages={totalPages}
				onPageChange={onPageChange}
			/>
		</div>
	);
}
