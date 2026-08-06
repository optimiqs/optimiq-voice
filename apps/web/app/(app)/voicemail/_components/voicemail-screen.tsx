"use client";

import { useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import {
	EnabledBadge,
	ListPagination,
	ListToolbar,
	ResourceTable,
	useListQueryState,
} from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { MenuItem } from "~/components/ui/menu";
import { PageHeader } from "~/components/ui/page-header";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { useLiveVoicemail } from "../../_hooks/use-live-queries";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { VoicemailBoxDialog } from "./voicemail-box-dialog";
import { VoicemailGreetingsDialog } from "./voicemail-greetings-dialog";
import { VoicemailMessagesDialog } from "./voicemail-messages-dialog";
import { VoicemailPinDialog } from "./voicemail-pin-dialog";
import type { VoicemailBoxRow } from "~/lib/pbx/contracts";

/**
 * Voicemail boxes.
 *
 * A box is a destination in its own right — anything can point at it — so deleting one that a
 * ring group's timeout or an IVR's invalid branch targets is refused with the referrers named.
 *
 * ## Two things live behind the row actions, and neither is a column
 *
 * **Messages** open in their own dialog. They are not a column because a mailbox's contents are
 * not a property of its configuration — they change without anybody editing anything, they are
 * paginated, and a count on this table would be one query per row on every page load. What the
 * table CAN show cheaply is the unread count once a `voicemail.mwi.updated` arrives while the page
 * is open, which is the live overlay below: it starts empty (there is no snapshot for this topic)
 * and fills in as mailboxes change, so the column reads "—" until there is something true to say.
 *
 * **The PIN** is a dialog rather than a field on the edit form because the server never returns
 * `pinHash` — it is stripped from every response — so there is no current value to prefill and no
 * way to render "a PIN is set". A secret with a write-only lifecycle does not belong in a form
 * that round-trips a row.
 */
export function VoicemailScreen() {
	const resource = PBX_RESOURCES.voicemailBoxes;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const canListen = usePermission("voicemail.listen");

	const [editing, setEditing] = useState<VoicemailBoxRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<VoicemailBoxRow | null>(null);
	const [messagesFor, setMessagesFor] = useState<VoicemailBoxRow | null>(null);
	const [pinFor, setPinFor] = useState<VoicemailBoxRow | null>(null);
	const [greetingsFor, setGreetingsFor] = useState<VoicemailBoxRow | null>(null);

	const live = useLiveVoicemail();

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New mailbox
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Voicemail"
				description="Mailboxes, how messages reach the people who own them, and how long they are kept."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Mailbox, label or email"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No mailboxes yet"
				emptyDescription="A voicemail box is where an unanswered call leaves a message. Anything that can route a call can send it here."
				emptyAction={createButton}
				caption="Voicemail boxes in this organization"
				columns={[
					{
						key: "mailboxNumber",
						header: "Mailbox",
						className: "font-medium whitespace-nowrap",
						cell: (row) => row.mailboxNumber,
					},
					{ key: "label", header: "Label", cell: (row) => row.label ?? "—" },
					{
						key: "delivery",
						header: "Delivery",
						cell: (row) => (
							<div className="flex flex-col">
								<span>{row.emailAddress ?? "No email"}</span>
								<span className="text-xs text-muted-foreground">
									{row.emailMode === "none"
										? "Kept in the box only"
										: row.emailMode === "attach"
											? "Recording attached"
											: "Notification only"}
									{row.deleteAfterDelivery ? " · deleted after sending" : ""}
								</span>
							</div>
						),
					},
					{
						key: "unread",
						header: "Unread",
						className: "whitespace-nowrap",
						/*
						 * Only ever the LIVE count, never a fetched one. There is no snapshot behind the
						 * voicemail topic (the counts live in `voicemail_message`, which this list does
						 * not join), so a mailbox nothing has happened to shows an em dash rather than a
						 * zero — "I have not been told" and "there are none" are different facts and a
						 * table that conflated them would be quietly wrong for every mailbox on the page.
						 */
						cell: (row) => {
							const counts = live.counts.get(row.id);
							return counts === undefined ? (
								<span className="text-muted-foreground">—</span>
							) : (
								<Badge tone={counts.newCount > 0 ? "accent" : "neutral"}>
									{counts.newCount}
								</Badge>
							);
						},
					},
					{
						key: "features",
						header: "Features",
						cell: (row) => (
							<div className="flex flex-wrap gap-1">
								{row.mwiEnabled ? <Badge tone="accent">MWI</Badge> : null}
								{row.transcriptionEnabled ? <Badge tone="neutral">Transcribed</Badge> : null}
							</div>
						),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`mailbox ${row.mailboxNumber}`}
						extra={
							<>
								{canListen ? (
									<MenuItem onClick={() => setMessagesFor(row)}>Messages</MenuItem>
								) : null}
								<MenuItem onClick={() => setGreetingsFor(row)}>Greetings…</MenuItem>
								{canWrite ? <MenuItem onClick={() => setPinFor(row)}>Set PIN…</MenuItem> : null}
							</>
						}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
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
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={setPage}
			/>

			<VoicemailBoxDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				box={editing}
			/>

			{/*
			 * Keyed by the mailbox so opening a second one remounts rather than reusing the first's
			 * folder tab and page. The alternative — resetting on close — leaves the previous
			 * mailbox's rows on screen for a frame while the new query resolves.
			 */}
			<VoicemailMessagesDialog
				key={`messages-${messagesFor?.id ?? "none"}`}
				open={messagesFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setMessagesFor(null);
					}
				}}
				box={messagesFor}
			/>

			{/*
			 * Keyed for the same reason the message dialog is: the upload form and the four slots are
			 * per-mailbox state, and reusing them across two mailboxes would show the first one's
			 * greetings while the second one's query resolves.
			 *
			 * The menu item is not permission-gated, unlike Messages and Set PIN. Reading a mailbox's
			 * greetings needs nothing narrower than the read that put the row on this table — hearing
			 * one needs `voicemail.listen` and changing one needs `voicemail.write`, and the dialog
			 * gates each of those on the control that performs it.
			 */}
			<VoicemailGreetingsDialog
				key={`greetings-${greetingsFor?.id ?? "none"}`}
				open={greetingsFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setGreetingsFor(null);
					}
				}}
				box={greetingsFor}
			/>

			<VoicemailPinDialog
				key={`pin-${pinFor?.id ?? "none"}`}
				open={pinFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPinFor(null);
					}
				}}
				box={pinFor}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="mailbox"
				entityName={pendingDelete ? `mailbox ${pendingDelete.mailboxNumber}` : "this mailbox"}
				description="The mailbox and its messages are removed. Anything that sends calls here — a ring group's timeout, an IVR branch, a DID — must be re-pointed first; the delete is refused while anything still targets it."
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
