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
import { ConferenceDialog } from "./conference-dialog";
import type { ConferenceRow } from "~/lib/pbx/contracts";

/**
 * Conference rooms.
 *
 * A room has no destination of its own — a conference is where a call ENDS UP, not a step on the
 * way somewhere else, and a participant who leaves has hung up. So there is no timeout branch to
 * configure and no detail page: a room is one flat row, edited in a dialog over its list.
 *
 * What DOES point at a room — DIDs, IVR options, ring-group timeouts — is surfaced where it matters
 * most: the delete is refused while anything still targets it, and the confirmation names every
 * referrer as a link.
 */
export function ConferencesScreen() {
	const resource = PBX_RESOURCES.conferences;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<ConferenceRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<ConferenceRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New conference room
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Conferences"
				description="Rooms people dial to end up in the same call. PINs are managed separately — the API hashes them behind an endpoint rather than accepting a digest here."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name or room number"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No conference rooms yet"
				emptyDescription="A room is a number several people dial to end up in one call. Give it a number and a size."
				emptyAction={createButton}
				caption="Conference rooms in this organization"
				columns={[
					{
						key: "roomNumber",
						header: "Dial",
						className: "font-mono font-medium whitespace-nowrap",
						cell: (row) => row.roomNumber,
					},
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "maxMembers",
						header: "Seats",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								up to {row.maxMembers}
							</span>
						),
					},
					{
						key: "behaviour",
						header: "Behaviour",
						cell: (row) => (
							<div className="flex flex-wrap gap-1">
								{row.waitForModerator ? <Badge tone="warning">Waits for moderator</Badge> : null}
								{row.recordEnabled ? <Badge tone="accent">Recorded</Badge> : null}
								{row.announceJoinLeave ? <Badge tone="neutral">Announces</Badge> : null}
								{!row.waitForModerator && !row.recordEnabled && !row.announceJoinLeave ? "—" : null}
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
						label={`conference room ${row.roomNumber}`}
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

			<ConferenceDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				conference={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="conference room"
				entityName={
					pendingDelete ? `${pendingDelete.roomNumber} · ${pendingDelete.name}` : "this room"
				}
				description="Anyone in the room when it goes is unaffected; the number simply stops answering. Anything that routes calls into it must be re-pointed first — the delete is refused while anything still targets it."
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
