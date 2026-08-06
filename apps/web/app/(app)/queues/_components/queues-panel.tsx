"use client";

import Link from "next/link";
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
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { QueueDialog } from "./queue-dialog";
import type { QueueRow } from "~/lib/pbx/contracts";

/** The queues themselves. Who staffs each one lives on its own page. */
export function QueuesPanel() {
	const resource = PBX_RESOURCES.queues;
	const state = useListQueryState();
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<QueueRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<QueueRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New queue
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or internal number"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No queues yet"
				emptyDescription="A queue holds callers until someone is free to take them. Create the queue, then staff it from its own page."
				emptyAction={createButton}
				caption="Queues in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.queue(row.id)}
								className="text-primary underline-offset-4 hover:underline"
							>
								{row.name}
							</Link>
						),
					},
					{
						key: "extensionNumber",
						header: "Dial directly",
						cell: (row) => row.extensionNumber ?? "—",
					},
					{
						key: "strategy",
						header: "Offers calls",
						cell: (row) => <Badge tone="neutral">{row.strategy}</Badge>,
					},
					{
						key: "wait",
						header: "Waits",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.maxWaitSeconds === 0 ? "indefinitely" : `up to ${row.maxWaitSeconds}s`}
							</span>
						),
					},
					{
						key: "timeout",
						header: "Then goes to",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "timeout"),
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
						label={`queue ${row.name}`}
						detailHref={routes.queue(row.id)}
						detailLabel="Open queue"
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
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<QueueDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				queue={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="queue"
				entityName={pendingDelete ? pendingDelete.name : "this queue"}
				description="The queue and its memberships go; the agents themselves stay and keep serving every other queue they are in. Anything that sends calls here must be re-pointed first — the delete is refused while anything still targets it."
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
