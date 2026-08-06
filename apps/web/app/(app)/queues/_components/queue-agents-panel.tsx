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
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { QueueAgentDialog } from "./queue-agent-dialog";
import { AgentStatusBadge } from "./queue-shared";
import { QueueTierDialog } from "./queue-tier-dialog";
import type { ExtensionRow, QueueAgentRow } from "~/lib/pbx/contracts";

/**
 * Every agent in the organization, and — from this side — which queue to put one in.
 *
 * All of it is `queues.manage-agents`, deliberately NOT `queues.write`: staffing the floor and
 * re-pointing a queue's overflow at an external number are different jobs, and the API guards them
 * with different grants. A reader with `queues.read` alone gets the table and no buttons.
 */
export function QueueAgentsPanel() {
	const resource = PBX_RESOURCES.queueAgents;
	const state = useListQueryState("a");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	/**
	 * One grant covers create, edit, delete and assignment, because it is one grant on the server:
	 * `queues.manage-agents` guards `POST /queue-agents` and `POST /queues/:id/tiers` alike.
	 */
	const canManage = usePermission(resource.permissions.write);

	/** Only to name the extension an agent answers on; the row stores an id. */
	const extensions = usePbxList(PBX_RESOURCES.extensions, { page: 1, limit: 100 });
	const extensionNames = new Map(
		extensions.rows.map((row: ExtensionRow) => [row.id, PBX_RESOURCES.extensions.displayName(row)]),
	);

	const [editing, setEditing] = useState<QueueAgentRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [assigning, setAssigning] = useState<QueueAgentRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<QueueAgentRow | null>(null);

	const createButton = canManage ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New agent
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or number"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No agents yet"
				emptyDescription="An agent is someone a queued call can be offered to. Create them here, then put them in the queues they serve."
				emptyAction={createButton}
				caption="Queue agents in this organization"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "contact",
						header: "Reached on",
						cell: (row) =>
							row.contactKind === "extension"
								? (extensionNames.get(row.extensionId ?? "") ??
									(row.extensionId ? `${row.extensionId.slice(0, 8)}…` : "—"))
								: (row.contact ?? "—"),
					},
					{
						key: "kind",
						header: "Via",
						cell: (row) => (
							<Badge tone={row.contactKind === "extension" ? "neutral" : "accent"}>
								{row.contactKind}
							</Badge>
						),
					},
					{
						key: "status",
						header: "Status",
						cell: (row) => <AgentStatusBadge status={row.status} />,
					},
					{
						key: "penalties",
						header: "Misses allowed",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.maxNoAnswer}
							</span>
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
						label={`agent ${row.name}`}
						onEdit={
							canManage
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						extra={
							canManage ? (
								<MenuItem onClick={() => setAssigning(row)}>Add to a queue…</MenuItem>
							) : null
						}
						onDelete={
							canManage
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
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<QueueAgentDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				agent={editing}
			/>

			{assigning ? (
				<QueueTierDialog
					key={`assign-${assigning.id}`}
					open
					onOpenChange={(open) => {
						if (!open) {
							setAssigning(null);
						}
					}}
					tier={null}
					fixedAgentId={assigning.id}
				/>
			) : null}

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="agent"
				entityName={pendingDelete ? pendingDelete.name : "this agent"}
				description="Deleting an agent is 'this person has left': their memberships go with them, in every queue they served. To take someone out of one queue, remove that membership on the queue's page instead."
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
