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
import { Button } from "~/components/ui/button";
import { PageHeader } from "~/components/ui/page-header";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { IvrMenuDialog } from "./ivr-menu-dialog";
import type { IvrMenuRow } from "~/lib/pbx/contracts";

/**
 * IVR menus.
 *
 * The row's name links to the menu's own page, where its digit options live. That is where the
 * work actually happens — a menu without options is just a greeting — so the name is a link
 * rather than the menu being editable only through the dialog.
 */
export function IvrScreen() {
	const resource = PBX_RESOURCES.ivrMenus;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<IvrMenuRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<IvrMenuRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New IVR menu
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="IVR menus"
				description="“Press 1 for sales.” Each menu answers, plays a greeting and routes on what the caller dials."
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
				emptyTitle="No IVR menus yet"
				emptyDescription="A menu answers a call, plays a greeting and sends the caller wherever the digit they press points."
				emptyAction={createButton}
				caption="IVR menus in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.ivrMenu(row.id)}
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
						key: "timeout",
						header: "On silence",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "timeout"),
							),
					},
					{
						key: "invalid",
						header: "On wrong entry",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "invalid"),
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
						label={`IVR menu ${row.name}`}
						detailHref={routes.ivrMenu(row.id)}
						detailLabel="Open menu"
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

			<IvrMenuDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				menu={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="menu"
				entityName={pendingDelete ? pendingDelete.name : "this menu"}
				description="The menu and its digit options are removed. Anything that sends calls into this menu — a DID, an inbound route, another menu's option — must be re-pointed first; the delete is refused while anything still targets it."
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
