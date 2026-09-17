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
import { routes, routingTabHref } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { PinSetDialog } from "./pin-set-dialog";
import type { PinSetRow } from "~/lib/pbx/contracts";

/**
 * Outbound authorisation codes.
 *
 * A resource of its own rather than a tab of Routing, and the permission registry's argument is
 * worth restating on the screen that carries it: the blast radius is money. The same grant that adds
 * a code removes one, so whoever holds `pin-sets.write` can make an international route dialable by
 * everybody in the building — which is a strictly larger power than re-ordering a trunk list, and it
 * belongs to somebody who can be named when the bill arrives.
 *
 * `pin-sets.read` is a real grant despite there being no secret to read: what a reader sees is which
 * routes are gated and by whose codes, which is exactly what somebody diagnosing "why is this phone
 * asking me for a number" needs.
 */
export function PinSetsScreen() {
	const resource = PBX_RESOURCES.pinSets;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<PinSetRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<PinSetRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New PIN set
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Authorisation codes"
				description="A list of codes an outbound route can demand before it dials a carrier. Codes are stored hashed and are never readable — a call record names which code authorised a call, never the digits."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name or description"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No PIN sets yet"
				emptyDescription="Create a set, add the codes to it, then attach it to the outbound route you want gated."
				emptyAction={createButton}
				caption="Authorisation code sets"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.pinSet(row.id)}
								className="text-primary underline-offset-4 hover:underline"
							>
								{row.name}
							</Link>
						),
					},
					{ key: "description", header: "Description", cell: (row) => row.description ?? "—" },
					{
						key: "maxAttempts",
						header: "Attempts",
						cell: (row) => <span data-tabular>{row.maxAttempts}</span>,
					},
					{
						key: "digitTimeoutMs",
						header: "Digit timeout",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.digitTimeoutMs} ms
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
						label={`PIN set ${row.name}`}
						detailHref={routes.pinSet(row.id)}
						detailLabel="Open codes"
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
				A set does nothing until an{" "}
				<Link
					href={routingTabHref("outbound")}
					className="text-primary underline-offset-4 hover:underline"
				>
					outbound route
				</Link>{" "}
				carries it. That attachment is not editable from this application yet — the column exists
				and the compiler reads it, but no endpoint accepts it in a request body, so a set is
				attached to a route outside the admin interface for now.
			</p>

			<PinSetDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				pinSet={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="PIN set"
				entityName={pendingDelete ? pendingDelete.name : "this PIN set"}
				description="Every code in it goes with it. Routes gated by this set must be changed first — the delete is refused while one still names it, because a gate that silently disappears is the worst possible way for a delete to succeed."
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
