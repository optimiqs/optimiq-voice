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
import { PageHeader } from "~/components/ui/page-header";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { VoicemailBoxDialog } from "./voicemail-box-dialog";
import type { VoicemailBoxRow } from "~/lib/pbx/contracts";

/**
 * Voicemail boxes.
 *
 * A box is a destination in its own right — anything can point at it — so deleting one that a
 * ring group's timeout or an IVR's invalid branch targets is refused with the referrers named.
 * Messages already in the box are a separate concern the P5 mailbox surface will own; this page
 * is about the box's configuration.
 */
export function VoicemailScreen() {
	const resource = PBX_RESOURCES.voicemailBoxes;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<VoicemailBoxRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<VoicemailBoxRow | null>(null);

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
