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
import { SharedLineDialog } from "./shared-line-dialog";
import type { SharedLineRow } from "~/lib/pbx/contracts";

/** How the appearances are offered a call to the line's number. */
const STRATEGY_LABELS: Readonly<Record<SharedLineRow["strategy"], string>> = {
	simultaneous: "All at once",
	sequential: "In order",
};

/**
 * Shared lines: one line that appears on several handsets and behaves as ONE seizable thing.
 *
 * The list looks like the ring-group and paging-group lists it sits beside, and is missing the same
 * column for the same reason those two are: a shared line has no "if nobody answers" destination,
 * because it does not route a call out — its whole point is the state it keeps AFTER the answer,
 * which lives in a KV claim the engine arbitrates rather than in a branch.
 *
 * There is deliberately no "appearances" count column, exactly as the paging list has no member
 * count: the row does not carry one, and counting the children of every line on the page would be a
 * request per row. The count lives on the line's own page, where the appearances are already
 * fetched. What the list shows instead is how the line offers itself and how it recalls — the two
 * facts that distinguish one shared line from another at a glance.
 *
 * "Dial directly" is genuinely optional here, more so than on a ring group: a line that is only a
 * shared KEY across a boss and an assistant has no number at all, and an em dash in that cell is a
 * complete answer rather than a missing one.
 */
export function SharedLinesScreen() {
	const resource = PBX_RESOURCES.sharedLines;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<SharedLineRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<SharedLineRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New shared line
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Shared lines"
				description="One line that appears on several handsets and behaves as one: seize it on one desk and the others' lamps go busy, answer it on one and it can be picked up on another. Add the appearances — one button per extension — on the line's page."
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
				emptyTitle="No shared lines yet"
				emptyDescription="A shared line puts one line on several handsets, each on a button of its own. Create the line, then add the appearances it lights."
				emptyAction={createButton}
				caption="Shared lines in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.sharedLine(row.id)}
								className="text-primary underline-offset-4 hover:underline"
							>
								{row.name}
							</Link>
						),
					},
					{
						key: "extensionNumber",
						header: "Dial directly",
						/** No number is a complete answer: the line is reached only through its member buttons. */
						cell: (row) => row.extensionNumber ?? "—",
					},
					{
						key: "strategy",
						header: "Offers",
						cell: (row) => <Badge tone="neutral">{STRATEGY_LABELS[row.strategy]}</Badge>,
					},
					{
						key: "recall",
						header: "Recalls held calls",
						/** `0` disables recall — the line holds indefinitely — which the copy states plainly. */
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.holdRecallTimeoutSeconds === 0
									? "Never"
									: `After ${row.holdRecallTimeoutSeconds}s`}
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
						label={`shared line ${row.name}`}
						detailHref={routes.sharedLine(row.id)}
						detailLabel="Open line"
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

			<SharedLineDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				line={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="shared line"
				entityName={pendingDelete ? pendingDelete.name : "this shared line"}
				description="The line and its appearances are removed. The extensions themselves are untouched — their buttons simply stop lighting for this line."
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
