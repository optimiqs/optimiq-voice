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
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { TrunkDialog } from "./trunk-dialog";
import type { TrunkRow, TrunkStatus } from "~/lib/pbx/contracts";

/**
 * Trunks: how calls leave and arrive.
 *
 * `status` is shown but never editable — it is what the engine observed, and an admin who could
 * set it could declare a dead carrier healthy. A trunk referenced by an outbound route cannot be
 * deleted; the reference lives inside `outbound_route.trunk_priority` (JSONB), which no foreign
 * key can express, so the API scans for it explicitly and answers 409.
 */
const STATUS_TONE: Readonly<Record<TrunkStatus, "success" | "danger" | "warning" | "neutral">> = {
	up: "success",
	down: "danger",
	degraded: "warning",
	disabled: "neutral",
	unknown: "neutral",
};

export function TrunksScreen() {
	const resource = PBX_RESOURCES.trunks;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<TrunkRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<TrunkRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New trunk
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Trunks"
				description="The carrier connections calls travel over. Status is what the engine last observed — it cannot be set here."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name, domain or proxy"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No trunks yet"
				emptyDescription="A trunk is a carrier connection. Outbound routes choose between them in priority order; without one, no call can leave."
				emptyAction={createButton}
				caption="SIP trunks in this organization"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "proxy",
						header: "Where it connects",
						cell: (row) => (
							<div className="flex flex-col">
								<span className="font-mono text-xs">{row.sipProxy}</span>
								<span className="text-xs text-muted-foreground">
									{row.sipDomain} · {row.transport.toUpperCase()} · {row.kind}
								</span>
							</div>
						),
					},
					{
						key: "capacity",
						header: "Capacity",
						cell: (row) => (row.maxChannels === null ? "No limit" : `${row.maxChannels} calls`),
					},
					{
						key: "status",
						header: "Carrier status",
						cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>,
					},
					{
						key: "provider",
						header: "Provider",
						cell: (row) =>
							row.carrierProvider === null ? (
								<Badge tone="neutral">BYO SIP</Badge>
							) : (
								<Badge tone="accent">{row.carrierProvider}</Badge>
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
						label={`trunk ${row.name}`}
						detailHref={routes.trunk(row.id)}
						detailLabel="Open"
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

			<TrunkDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				trunk={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="trunk"
				entityName={pendingDelete ? pendingDelete.name : "this trunk"}
				description="Calls stop using this carrier immediately. Any outbound route that lists this trunk must drop it first — the delete is refused while a route still names it, so no route is left with nowhere to send a call."
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
