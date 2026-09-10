"use client";

import Link from "next/link";
import { parseAsBoolean, parseAsString, useQueryState } from "nuqs";
import { useEffect, useId, useMemo } from "react";
import { useDebounced } from "~/components/pbx/use-debounced";
import { Badge } from "~/components/ui/badge";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { MessageIcon } from "~/components/ui/icons";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { cn } from "~/lib/cn";
import { DEFAULT_CONVERSATION_LIMIT } from "~/lib/messaging/client";
import { formatE164, registrationStatusPresentation } from "~/lib/messaging/format";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import {
	useConversationMessages,
	useConversations,
	useMarkConversationRead,
	useMessagingNumbers,
	useUpdateConversation,
} from "../../_hooks/use-messaging-queries";
import { ConversationList } from "./conversation-list";
import { ThreadView } from "./thread-view";

/**
 * The inbox.
 *
 * ## Three panes, and the first one is a `<select>`
 *
 * A number picker, a thread list, a thread. The number picker is deliberately NOT a third column:
 * an organization has a handful of messaging numbers, not a directory of them, and spending a
 * quarter of a laptop screen on a list that is usually two rows long would leave the thread — the
 * only pane anybody reads — squeezed. It is a labelled select above the list, which is also what
 * makes the whole surface survive a narrow window without a second layout.
 *
 * ## Everything that identifies WHAT is being read is in the URL
 *
 * The number, the thread, the search and the archive filter, all `nuqs` query state. A support
 * conversation about a message is "look at this thread", which has to be a link — the same
 * argument `/cdr` and the PBX lists make. The page NUMBER is in the URL too, unlike the CDR's
 * cursor, because this list is offset-paged and "page 3 of the archive" is a place a colleague can
 * usefully be sent.
 *
 * ## Reading a thread marks it read, and that is a write nobody asked for
 *
 * So it is silent: no toast, no spinner, and a failure leaves the unread badge exactly where it
 * was — which is the honest answer rather than an error about something the user did not do.
 */
export function MessagingScreen() {
	const numberSelectId = useId();
	const canSend = usePermission("messaging.send");
	const canManage = usePermission("messaging.manage");

	const numbers = useMessagingNumbers();
	const [numberId, setNumberId] = useQueryState(
		"number",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [conversationId, setConversationId] = useQueryState(
		"c",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [archived, setArchived] = useQueryState(
		"archived",
		parseAsBoolean.withDefault(false).withOptions({ clearOnDefault: true }),
	);
	const [page, setPage] = useQueryState(
		"page",
		parseAsString.withDefault("1").withOptions({ clearOnDefault: true }),
	);

	/**
	 * The number the list is scoped to.
	 *
	 * Falls back to the first row rather than to "all numbers", and the reason is the composer: a
	 * reply has to go OUT from a specific number, so a list mixing threads from three numbers would
	 * put the operator one click away from answering a customer from a number they have never seen.
	 * One number at a time is what makes every reply unambiguous.
	 */
	const selectedNumber = useMemo(
		() => numbers.rows.find((row) => row.id === numberId) ?? numbers.rows[0],
		[numbers.rows, numberId],
	);

	const debouncedSearch = useDebounced(search, 250);
	const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);

	const conversations = useConversations({
		numberId: selectedNumber?.id,
		archived,
		search: debouncedSearch.length > 0 ? debouncedSearch : undefined,
		page: pageNumber,
		limit: DEFAULT_CONVERSATION_LIMIT,
	});

	const selectedConversation = useMemo(
		() => conversations.rows.find((row) => row.id === conversationId),
		[conversations.rows, conversationId],
	);

	const messages = useConversationMessages(selectedConversation?.id);
	const markRead = useMarkConversationRead();
	const updateConversation = useUpdateConversation();

	/**
	 * Marking read is keyed on the thread id and fires once per thread opened. `mutate` is stable
	 * and the unread count is deliberately NOT a dependency: it changes as a result of this call, so
	 * including it would run the effect again on its own answer.
	 */
	const { mutate: markConversationRead } = markRead;
	const openConversationId = selectedConversation?.id;
	const openHasUnread = (selectedConversation?.unreadCount ?? 0) > 0;
	useEffect(() => {
		if (openConversationId !== undefined && openHasUnread) {
			markConversationRead(openConversationId);
		}
	}, [markConversationRead, openConversationId, openHasUnread]);

	if (numbers.query.isPending) {
		return (
			<>
				<PageHeader title="Messaging" description="Conversations on this organization's numbers." />
				<LoadingPanel label="Loading messaging numbers" />
			</>
		);
	}

	if (numbers.rows.length === 0) {
		return (
			<>
				<PageHeader
					title="Messaging"
					description="Conversations on this organization's numbers — SMS and MMS, in and out."
				/>
				<EmptyState
					icon={<MessageIcon />}
					title="No number can send or receive messages yet"
					description={
						canManage
							? "Enable messaging on one of this organization's phone numbers, register a 10DLC brand and campaign — or verify a toll-free number — and its conversations appear here."
							: "An administrator has to enable messaging on one of this organization's phone numbers before any conversation can appear here."
					}
					action={
						canManage ? (
							<Link
								href={routes.messagingNumbers}
								className="text-sm text-primary underline-offset-4 hover:underline"
							>
								Set up messaging numbers
							</Link>
						) : null
					}
				/>
			</>
		);
	}

	const registration = selectedNumber
		? registrationStatusPresentation(selectedNumber.registrationStatus)
		: undefined;

	return (
		<>
			<PageHeader
				title="Messaging"
				description="Conversations on this organization's numbers — SMS and MMS, in and out. A reply always goes out from the number the thread arrived on."
			/>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={numberSelectId} className="text-xs font-medium text-muted-foreground">
						Messaging number
					</label>
					<select
						id={numberSelectId}
						value={selectedNumber?.id ?? ""}
						onChange={(event) => {
							void setNumberId(event.target.value);
							void setConversationId("");
							void setPage("1");
						}}
						className={cn(inputClassName, "w-64 pr-8")}
					>
						{numbers.rows.map((row) => (
							<option key={row.id} value={row.id}>
								{formatE164(row.e164)}
								{row.enabled ? "" : " — disabled"}
							</option>
						))}
					</select>
				</div>

				{registration ? (
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-medium text-muted-foreground">Registration</span>
						<span className="flex h-9 items-center">
							<Badge tone={registration.tone}>{registration.label}</Badge>
						</span>
					</div>
				) : null}
			</div>

			{/**
			 * The registration reason, above the panes rather than inside the composer.
			 *
			 * It explains every thread on this number at once, which is exactly why it does not belong
			 * in the composer: the composer's job is the ONE send it just refused, and a number-wide
			 * fact repeated under every thread would compete with it.
			 */}
			{selectedNumber && selectedNumber.registrationStatus !== "registered" ? (
				<p className="max-w-prose rounded-field border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-foreground">
					{selectedNumber.registrationReason ??
						"This number has not completed carrier registration, so the carriers may filter or refuse messages sent from it."}{" "}
					{canManage ? (
						<Link
							href={routes.messagingNumbers}
							className="text-primary underline-offset-4 hover:underline"
						>
							Review its registration
						</Link>
					) : null}
				</p>
			) : null}

			<div className="grid min-h-0 gap-4 lg:grid-cols-[22rem_1fr]">
				<ConversationList
					conversations={conversations.rows}
					isPending={conversations.query.isPending}
					selectedId={selectedConversation?.id}
					onSelect={(conversation) => {
						void setConversationId(conversation.id);
					}}
					search={search}
					onSearchChange={(value) => {
						void setSearch(value);
						void setPage("1");
					}}
					archived={archived}
					onArchivedChange={(value) => {
						void setArchived(value);
						void setConversationId("");
						void setPage("1");
					}}
					page={pageNumber}
					total={conversations.total}
					totalPages={conversations.totalPages}
					onPageChange={(next) => {
						void setPage(String(next));
					}}
					hasNumber={selectedNumber !== undefined}
				/>

				<ThreadView
					conversation={selectedConversation}
					messages={messages.rows}
					isPending={selectedConversation !== undefined && messages.query.isPending}
					messagingNumberId={selectedNumber?.id}
					localE164={selectedNumber?.e164}
					canSend={canSend}
					archivePending={updateConversation.isPending}
					onArchiveToggle={() => {
						if (!selectedConversation) {
							return;
						}
						updateConversation.mutate({
							id: selectedConversation.id,
							values: { archived: !selectedConversation.archived },
						});
					}}
				/>
			</div>
		</>
	);
}
