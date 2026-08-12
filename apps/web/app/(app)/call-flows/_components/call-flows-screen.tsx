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
import { routingTabHref } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { useCallFlowToggle, usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { CallFlowDialog } from "./call-flow-dialog";
import type { CallFlowRow } from "~/lib/pbx/contracts";

/**
 * Call flows — the day/night switch.
 *
 * ## Why the toggle is a button in the row rather than a field in the dialog
 *
 * Four grants guard this screen and only three of them are CRUD. `call-flows.toggle` is the fourth,
 * it is what a receptionist holds, and it is the whole reason the feature exists: the office closes
 * early for a funeral and somebody at the front desk has to move every inbound call to the
 * after-hours branch, right now, without holding the grant that re-points either branch.
 *
 * So the mode is a control on the LIST — reachable in one click from the sidebar by a person with no
 * other permission on this page — and the dialog behind "Edit" has no mode field at all. The server
 * enforces the same split: `mode` is absent from both write DTOs, and the toggle endpoint also
 * publishes the busy-lamp presence entry that a `PATCH` would have skipped.
 *
 * ## What a flip costs
 *
 * A recompile. `call_flow` is in `ROUTING_TABLE_TO_ENTITY`, so the mode is a COLUMN compiled into the
 * artifact rather than live state read at dial time — which is what makes "what is this tenant's
 * routing right now" answerable from the artifact alone, and what makes a flip a routing write like
 * any other. The page says so, because a button that quietly republishes the dial plan should say it
 * does.
 */
export function CallFlowsScreen() {
	const resource = PBX_RESOURCES.callFlows;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);
	const toggle = useCallFlowToggle();

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);
	const canToggle = usePermission("call-flows.toggle");

	const [editing, setEditing] = useState<CallFlowRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<CallFlowRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New call flow
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Call flows"
				description="A switch with two positions. Calls take the day destination or the night one, and nothing moves it but a person — a call flow does not read the clock, which is what a time condition is for."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name, number or code"
				action={null}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No call flows yet"
				emptyDescription="Create a flow with a day and a night destination, then point an inbound route at it. Whoever is on the front desk moves the switch from this page or from a handset."
				emptyAction={createButton}
				caption="Call flows in this organization"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "mode",
						header: "Position",
						cell: (row) => (
							<Badge tone={row.mode === "night" ? "accent" : "success"}>
								{row.mode === "night" ? "Night" : "Day"}
							</Badge>
						),
					},
					{
						key: "day",
						header: "Day goes to",
						cell: (row) =>
							describeDestination(readDestination(row as unknown as Record<string, unknown>, "")),
					},
					{
						key: "night",
						header: "Night goes to",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "night"),
							),
					},
					{
						key: "reach",
						header: "Reached by",
						className: "font-mono text-sm whitespace-nowrap",
						cell: (row) =>
							[row.extensionNumber, row.featureCode].filter(Boolean).join(" · ") || "—",
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<div className="flex items-center justify-end gap-2">
						{/*
						 * The switch, in the row and not behind the menu. It is the one action on this page
						 * somebody performs twice a day, and burying a twice-daily action under "Actions"
						 * to keep a table tidy is the wrong trade — especially for the person who holds
						 * `call-flows.toggle` and nothing else, for whom this button is the entire screen.
						 */}
						{canToggle ? (
							<Button
								size="sm"
								variant="secondary"
								loading={toggle.isPending && toggle.variables?.id === row.id}
								disabled={!row.enabled || toggle.isPending}
								onClick={() =>
									toggle.mutate({ id: row.id, mode: row.mode === "day" ? "night" : "day" })
								}
							>
								{row.mode === "day" ? "Switch to night" : "Switch to day"}
							</Button>
						) : null}
						<RowActions
							label={`call flow ${row.name}`}
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
					</div>
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
				Moving a switch republishes the routing model and relights every busy-lamp key watching it,
				so the change reaches handsets a moment after the button settles. To overrule a schedule
				instead of a switch, use the override on a{" "}
				<Link
					href={routingTabHref("time-conditions")}
					className="text-primary underline-offset-4 hover:underline"
				>
					time condition
				</Link>{" "}
				— it is the same permission and the same act on a different table.
			</p>

			<CallFlowDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				flow={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="call flow"
				entityName={pendingDelete ? pendingDelete.name : "this call flow"}
				description="Both destinations go with it, and the toggle code stops answering. Anything pointing at this flow must be re-pointed first — the delete is refused while one still does."
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
