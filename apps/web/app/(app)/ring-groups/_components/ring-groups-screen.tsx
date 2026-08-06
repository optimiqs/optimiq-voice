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
import { PageHeader } from "~/components/ui/page-header";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { RingGroupDialog } from "./ring-group-dialog";
import type { RingGroupRow } from "~/lib/pbx/contracts";

/** Ring groups: several endpoints ringing for one call. Members live on each group's page. */
export function RingGroupsScreen() {
	const resource = PBX_RESOURCES.ringGroups;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<RingGroupRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<RingGroupRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New ring group
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Ring groups"
				description="Several endpoints ringing for one call — together or one after another — and where the call goes if none of them answer."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name or internal number"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No ring groups yet"
				emptyDescription="A ring group lets one call reach several people. Create the group, then add the members it rings."
				emptyAction={createButton}
				caption="Ring groups in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.ringGroup(row.id)}
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
						header: "Rings",
						cell: (row) => (
							<div className="flex flex-col">
								<Badge tone="neutral">{row.strategy}</Badge>
								<span className="mt-1 text-xs text-muted-foreground">
									for {row.ringTimeoutSeconds}s
								</span>
							</div>
						),
					},
					{
						key: "timeout",
						header: "If nobody answers",
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
						label={`ring group ${row.name}`}
						detailHref={routes.ringGroup(row.id)}
						detailLabel="Open group"
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

			<RingGroupDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				group={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="ring group"
				entityName={pendingDelete ? pendingDelete.name : "this ring group"}
				description="The group and its member list are removed. The extensions themselves are untouched. Anything that sends calls into this group must be re-pointed first; the delete is refused while anything still targets it."
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
