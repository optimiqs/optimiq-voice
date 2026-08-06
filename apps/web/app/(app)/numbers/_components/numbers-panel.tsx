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
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { usePermission } from "../../_context/session-context";
import { useReleaseNumber } from "../../_hooks/use-carrier-queries";
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
 *
 * ## And a carrier-managed DID has two different deletes
 *
 * A number the platform bought can be removed from the organization, or removed AND given back to
 * the carrier — different endpoints with different consequences, one of which stops a recurring
 * charge. The row itself decides which one is offered, from `carrierProvider`: the second only
 * exists for a number we bought, and offering "release" for a hand-entered DID would promise to
 * cancel a bill this platform never created. The confirmation says which one is about to happen,
 * because "deleted" and "you stop paying for it" are not the same sentence.
 */
export function NumbersPanel() {
	const resource = PBX_RESOURCES.phoneNumbers;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);
	const release = useReleaseNumber();

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
						key: "source",
						header: "Source",
						cell: (row) =>
							row.carrierProvider === null ? (
								<Badge tone="neutral">Manual</Badge>
							) : (
								<Badge tone="accent">Carrier</Badge>
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
										release.reset();
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
						release.reset();
					}
				}}
				entityLabel={pendingDelete?.carrierProvider === null ? "number" : "carrier number"}
				entityName={pendingDelete ? pendingDelete.e164 : "this number"}
				description={
					pendingDelete?.carrierProvider === null
						? "Calls to this number stop reaching you immediately. Any inbound route narrowed to this specific number is deleted with it — those routes cannot exist without the number they match. Routes that match by pattern are left alone."
						: "This number is returned to the carrier and you stop being billed for it. It is not reserved for you afterwards — someone else may buy it. Any inbound route narrowed to this specific number is deleted with it; routes that match by pattern are left alone."
				}
				pending={remove.isPending || release.isPending}
				error={remove.error ?? release.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					const mutation = pendingDelete.carrierProvider === null ? remove : release;
					mutation.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
