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
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { PagingGroupDialog } from "./paging-group-dialog";
import type { PagingGroupRow } from "~/lib/pbx/contracts";

/**
 * Paging groups: an announcement made AT a set of handsets, which auto-answer it.
 *
 * The list looks like the ring-group list and is missing one column on purpose. A ring group has an
 * "If nobody answers" destination; this one has nothing in its place, because a page does not wait
 * for an answer — it causes one. The pager speaks, the handsets pick up, and the announcement is
 * over when the pager hangs up. There is no unanswered state to route out of, so there is no column
 * that could describe one.
 *
 * "Dial directly" is genuinely optional here, more so than on a ring group: a group reachable only
 * through the `*81` feature code has no number at all, and an em dash in that cell is a complete
 * answer rather than a missing one.
 */
export function PagingGroupsScreen() {
	const resource = PBX_RESOURCES.pagingGroups;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<PagingGroupRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<PagingGroupRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New paging group
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Paging groups"
				description="An announcement to a set of handsets, which auto-answer it. The page ends when whoever made it hangs up — there is nowhere for it to go afterwards."
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
				emptyTitle="No paging groups yet"
				emptyDescription="A paging group announces to several handsets at once. Create the group, then add the extensions it reaches."
				emptyAction={createButton}
				caption="Paging groups in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.pagingGroup(row.id)}
								className="text-primary underline-offset-4 hover:underline"
							>
								{row.name}
							</Link>
						),
					},
					{
						key: "extensionNumber",
						header: "Dial directly",
						/** No number is a complete answer: the group is reached through `*81` instead. */
						cell: (row) => row.extensionNumber ?? "—",
					},
					{
						key: "duplex",
						header: "Mode",
						cell: (row) =>
							row.duplex ? (
								<Badge tone="accent">Talkback</Badge>
							) : (
								<Badge tone="neutral">One-way</Badge>
							),
					},
					{
						key: "timeout",
						header: "Give a handset",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.timeoutSeconds}s to pick up
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
						label={`paging group ${row.name}`}
						detailHref={routes.pagingGroup(row.id)}
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

			<PagingGroupDialog
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
				entityLabel="paging group"
				entityName={pendingDelete ? pendingDelete.name : "this paging group"}
				description="The group and its member list are removed. The extensions themselves are untouched. Anything that sends calls into this group — an IVR option, an inbound route, or a *81 feature code pinned to it — must be re-pointed first; the delete is refused while anything still targets it."
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
