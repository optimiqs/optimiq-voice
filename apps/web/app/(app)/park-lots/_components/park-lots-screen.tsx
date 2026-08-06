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
import { routingTabHref } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { ParkLotDialog } from "./park-lot-dialog";
import type { ParkLotRow } from "~/lib/pbx/contracts";

/**
 * Call-park orbits.
 *
 * Gated on `park-lots.read`, which the `agent` template holds precisely so someone who parks calls
 * with `*5` can see which orbit a call landed in. Writing is `park-lots.write`, which they do not.
 *
 * A lot is named from inside a `jsonb` column — `feature_code.params.lotId` — so no foreign key can
 * express the link and the API's generic reverse scan cannot see it. It has a dedicated scan for
 * exactly this case, which is why deleting a lot a call-park code pins is refused rather than
 * silently leaving the code parking into nothing.
 */
export function ParkLotsScreen() {
	const resource = PBX_RESOURCES.parkLots;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<ParkLotRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<ParkLotRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New park lot
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Park lots"
				description="A parked call sits on a numbered slot until someone dials it back. Each lot owns a slot range and decides where a call goes when nobody comes back for it."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Lot name"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No park lots yet"
				emptyDescription="Create a lot with a range of slots, then point a call-park feature code at it so staff can put calls down and pick them back up."
				emptyAction={createButton}
				caption="Park lots in this organization"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "slots",
						header: "Slots",
						className: "font-mono whitespace-nowrap",
						cell: (row) => `${row.slotStart}–${row.slotEnd}`,
					},
					{
						key: "capacity",
						header: "Capacity",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.slotEnd - row.slotStart + 1} calls
							</span>
						),
					},
					{
						key: "timeoutSeconds",
						header: "Parks for",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.timeoutSeconds}s
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
						label={`park lot ${row.name}`}
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

			<p className="text-xs text-muted-foreground">
				Staff reach a lot through a call-park{" "}
				<Link
					href={routingTabHref("feature-codes")}
					className="text-primary underline-offset-4 hover:underline"
				>
					feature code
				</Link>
				, which can pin one lot or leave it open and take the first free slot anywhere.
			</p>

			<ParkLotDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				lot={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="park lot"
				entityName={pendingDelete ? pendingDelete.name : "this park lot"}
				description="The slots stop answering. A call-park feature code pinned to this lot would have nowhere to park, so the delete is refused while one still names it."
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
