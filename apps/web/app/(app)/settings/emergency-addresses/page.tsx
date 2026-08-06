"use client";

import { useId, useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { ListPagination, ResourceTable, useListQueryState } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { inputClassName } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { SettingsNav } from "../_components/settings-nav";
import { EmergencyAddressDialog } from "./_components/emergency-address-dialog";
import type { EmergencyAddressRow } from "~/lib/pbx/contracts";

/**
 * Dispatchable locations for 911.
 *
 * ## Why this screen is careful about what it claims
 *
 * An emergency address is only a DISPATCHABLE LOCATION once a carrier's E911 provisioning API has
 * validated it against the authoritative database and returned a reference. Nothing in this
 * platform talks to such an API yet, so `validated` is `false` on every row here and will stay
 * false — it is written by a provider and by nothing else, and the API refuses it in a request
 * body precisely so that nobody can set it from a browser.
 *
 * That makes the honest description of this feature "somewhere to record the addresses you will
 * need when 911 provisioning exists", not "E911 compliance". The copy at the top says so in as
 * many words, because a screen that lets an administrator fill in an address, assign it to a DID
 * and see no warning is a screen that has told them they are covered. They are not.
 *
 * ## Why it lives under Settings rather than beside Numbers
 *
 * An address is not a routing object — `emergency_address` is absent from `ROUTING_TABLE_TO_ENTITY`
 * and nothing in the routing package reads it — and it is shared across every DID that points at
 * it. It is a property of the ORGANIZATION's premises, which is what Settings is for. The
 * per-number assignment lives on the number, where the choice is actually made.
 *
 * ## Why reads and writes ask for different grants
 *
 * `numbers.read` to see the list, `numbers.emergency` to change it. Anyone who can look at the
 * Numbers screen can see which location a DID reports, because that is a question about the number;
 * changing where responders are sent is a narrower thing, and the descriptor says so.
 */
export default function EmergencyAddressesPage() {
	const resource = PBX_RESOURCES.emergencyAddresses;
	const searchId = useId();
	const { query, search, setSearch, page, setPage } = useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<EmergencyAddressRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<EmergencyAddressRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			Add address
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Emergency addresses"
				description="The street locations a 911 call from one of your numbers should send responders to."
				actions={createButton}
			/>
			<SettingsNav />

			<Card>
				<CardHeader>
					<CardTitle>These addresses are not validated</CardTitle>
					<CardDescription>
						An address becomes a dispatchable location only once the upstream carrier has validated
						it against the authoritative 911 database. This platform has no carrier E911
						integration yet, so every address below is stored and shown as{" "}
						<strong className="font-medium text-foreground">Not validated</strong> — recording one
						here does not make a number compliant. Fill in the floor, suite or room whenever there
						is one: that detail, not the street address, is what RAY BAUM&apos;S Act actually
						requires.
					</CardDescription>
				</CardHeader>
				<CardBody className="flex flex-col gap-6">
					{/*
					 * A bare search box rather than the shared `ListToolbar`, which also renders an
					 * enabled/disabled filter. `emergency_address` has no `enabled` column — an address is
					 * either recorded or it is not — and a filter that cannot change the result is worse
					 * than no filter, because somebody will use it and conclude the list is broken.
					 */}
					<div className="flex flex-wrap items-end gap-3">
						<div className="flex min-w-56 flex-1 flex-col gap-1.5">
							<label htmlFor={searchId} className="text-xs font-medium text-muted-foreground">
								Search
							</label>
							<input
								id={searchId}
								type="search"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								placeholder="Label, street or city"
								className={inputClassName}
							/>
						</div>
					</div>

					<ResourceTable
						rows={list.rows}
						isPending={list.query.isPending}
						filtered={search.length > 0}
						emptyTitle="No addresses yet"
						emptyDescription="Add the premises your numbers are used from. A number can then report one of them when somebody dials 911."
						emptyAction={createButton}
						caption="Emergency addresses in this organization"
						columns={[
							{
								key: "label",
								header: "Label",
								className: "font-medium",
								cell: (row) => row.label,
							},
							{
								key: "address",
								header: "Address",
								cell: (row) => (
									<div className="flex flex-col">
										<span className="text-sm">{oneLineAddress(row)}</span>
										{row.locationDetail === null ? (
											<span className="text-xs text-warning">No floor or room recorded</span>
										) : (
											<span className="text-xs text-muted-foreground">{row.locationDetail}</span>
										)}
									</div>
								),
							},
							{
								key: "validated",
								header: "Validation",
								cell: (row) =>
									row.validated ? (
										<Badge tone="success">Validated</Badge>
									) : (
										<Badge tone="warning">Not validated</Badge>
									),
							},
						]}
						rowActions={(row) => (
							<RowActions
								label={`emergency address ${row.label}`}
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
				</CardBody>
			</Card>

			<EmergencyAddressDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				address={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="emergency address"
				entityName={pendingDelete ? pendingDelete.label : "this address"}
				description="Any number assigned to this address stops reporting a location when somebody dials 911 from it. Re-assign those numbers first; the delete is refused while any still points here."
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

/**
 * The postal address on one line.
 *
 * Not `descriptor.displayName`, which is deliberately shorter (label plus street plus city) because
 * it has to fit inside a `<select>` option. A table cell has room for the whole thing, and an
 * address missing its postcode is an address somebody has to open the row to check.
 */
function oneLineAddress(row: EmergencyAddressRow): string {
	return [
		row.streetLine1,
		row.streetLine2,
		row.locality,
		row.administrativeArea,
		row.postalCode,
		row.country,
	]
		.filter((part): part is string => part !== null && part.length > 0)
		.join(", ");
}
