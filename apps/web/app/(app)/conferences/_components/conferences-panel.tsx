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
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES, type ConferencePinRole } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { ConferenceDialog } from "./conference-dialog";
import { ConferencePinDialog } from "./conference-pin-dialog";
import type { ConferenceRow } from "~/lib/pbx/contracts";

/**
 * The conference rooms — the CONFIGURATION half of the page.
 *
 * A room has no destination of its own: a conference is where a call ENDS UP, not a step on the way
 * somewhere else, and a participant who leaves has hung up. So there is no timeout branch to
 * configure and no detail page — a room is one flat row, edited in a dialog over its list.
 *
 * What DOES point at a room — DIDs, IVR options, ring-group timeouts — is surfaced where it matters
 * most: the delete is refused while anything still targets it, and the confirmation names every
 * referrer as a link.
 *
 * ## The two PINs are row actions, and neither is a column
 *
 * The server never returns `pinHash` or `moderatorPinHash` — they are stripped from every response
 * — so there is nothing for a column to render: this table cannot say whether a room has a PIN, and
 * a column that guessed would be wrong in the direction that matters. The actions describe what
 * they DO instead, which is the honest version, exactly as the voicemail screen does for its
 * mailbox PIN.
 *
 * One dialog component serves both, keyed by the room AND the role: opening the moderator PIN for
 * one room after the participant PIN of another must not reuse the first dialog's typed digits.
 */
export function ConferencesPanel() {
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
	const [pinFor, setPinFor] = useState<{
		readonly conference: ConferenceRow;
		readonly role: ConferencePinRole;
	} | null>(null);

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
			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name or room number"
				action={createButton}
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
								{row.recordPolicy !== "none" ? <Badge tone="accent">Recorded</Badge> : null}
								{row.announceJoinLeave ? <Badge tone="neutral">Announces</Badge> : null}
								{!row.waitForModerator && row.recordPolicy === "none" && !row.announceJoinLeave
									? "—"
									: null}
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
						extra={
							canWrite ? (
								<>
									<MenuItem onClick={() => setPinFor({ conference: row, role: "participant" })}>
										Room PIN…
									</MenuItem>
									<MenuItem onClick={() => setPinFor({ conference: row, role: "moderator" })}>
										Moderator PIN…
									</MenuItem>
								</>
							) : null
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

			<ConferenceDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				conference={editing}
			/>

			<ConferencePinDialog
				key={`pin-${pinFor?.role ?? "none"}-${pinFor?.conference.id ?? "none"}`}
				open={pinFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPinFor(null);
					}
				}}
				conference={pinFor?.conference ?? null}
				role={pinFor?.role ?? "participant"}
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
