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
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { PhoneNumberDialog } from "./phone-number-dialog";
import type { PhoneNumberRow } from "~/lib/pbx/contracts";

/**
 * Numbers: the DIDs the carrier delivers, and where each one lands by default.
 *
 * ## Deleting a DID is the one delete that cascades
 *
 * `inbound_route.phone_number_id` is a real foreign key with `on delete cascade`, so removing a
 * number silently removes every inbound route narrowed to it — unlike every other delete in this
 * area, which is refused rather than cascaded. That asymmetry is invisible in the API response
 * (the delete just succeeds), so the confirmation has to say it in words, before the click.
 */
export function NumbersScreen() {
	const resource = PBX_RESOURCES.phoneNumbers;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<PhoneNumberRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<PhoneNumberRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			Add number
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Numbers"
				description="The DIDs your carrier delivers, and where a call to each one goes when no inbound route claims it."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Number or label"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No numbers yet"
				emptyDescription="Add the DIDs your carrier delivers to this organization. Each one needs a destination — where the call goes when nothing else claims it."
				emptyAction={createButton}
				caption="Phone numbers in this organization"
				columns={[
					{
						key: "e164",
						header: "Number",
						className: "font-medium whitespace-nowrap",
						cell: (row) => row.e164,
					},
					{ key: "label", header: "Label", cell: (row) => row.label ?? "—" },
					{
						key: "destination",
						header: "Default destination",
						cell: (row) => (
							<span className="text-sm">
								{describeDestination(
									readDestination(row as unknown as Record<string, unknown>, ""),
								)}
							</span>
						),
					},
					{
						key: "capabilities",
						header: "Capabilities",
						cell: (row) => (
							<div className="flex flex-wrap gap-1">
								{row.voiceEnabled ? <Badge tone="accent">Voice</Badge> : null}
								{row.faxEnabled ? <Badge tone="neutral">Fax</Badge> : null}
								{row.recordEnabled ? <Badge tone="neutral">Recorded</Badge> : null}
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
						label={`number ${row.e164}`}
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

			<PhoneNumberDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				number={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="number"
				entityName={pendingDelete ? pendingDelete.e164 : "this number"}
				description="Calls to this number stop reaching you immediately. Any inbound route narrowed to this specific number is deleted with it — those routes cannot exist without the number they match. Routes that match by pattern are left alone."
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
