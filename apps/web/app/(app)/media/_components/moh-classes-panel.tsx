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
import { MenuItem } from "~/components/ui/menu";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { MohClassDialog } from "./moh-class-dialog";
import { MohFilesDialog } from "./moh-files-dialog";
import type { MohClassRow } from "~/lib/pbx/contracts";

/**
 * Hold-music classes: what a caller hears while nothing is happening to them.
 *
 * ## A class is a name before it is a playlist
 *
 * Five kinds of plan node carry a class's resolved NAME — not its id — because that is what the
 * media server looks up as a section in its own configuration. That is why `moh_class` is a routing
 * input (`affectsRouting: true` on the descriptor) and why renaming one has to recompile: a queue
 * that says "play `default`" stops playing anything the moment `default` is called something else.
 * The generic mutation hooks handle that already; it is stated here because it is the reason this
 * list's edits are more consequential than they look.
 *
 * ## Why the files are behind a row action and not a column
 *
 * A class's files are a separate, unpaginated collection under `/moh-classes/:id/files`. Counting
 * them in a column would be one request per row on every page load, for a number nobody acts on
 * without then wanting to see the list. And a `stream` class has no files at all — the column would
 * be blank for exactly the rows the source badge already explains.
 *
 * ## What this list does not offer
 *
 * There is no "make this the default" control on the row. `isDefault` is a field on the form, and
 * the server is what enforces that at most one class holds it — a row-level toggle would look like
 * an independent switch per row while actually being a radio group spread across pages.
 */
export function MohClassesPanel() {
	const resource = PBX_RESOURCES.mohClasses;
	// Prefixed, because the prompt tab's list state shares this URL — see `routing-panels.tsx`,
	// which does the same for the four lists behind its tabs.
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState("moh");
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);
	const canRead = usePermission(resource.permissions.read);

	const [editing, setEditing] = useState<MohClassRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<MohClassRow | null>(null);
	const [filesFor, setFilesFor] = useState<MohClassRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New hold music class
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Class name"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No hold music yet"
				emptyDescription="A class is a named playlist — or a stream — that queues, parking lots and transfers point at. Create one and upload the audio it should play."
				emptyAction={createButton}
				caption="Music-on-hold classes in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium whitespace-nowrap",
						cell: (row) => (
							<div className="flex flex-col">
								<span>{row.name}</span>
								{row.description === null ? null : (
									<span className="text-xs text-muted-foreground">{row.description}</span>
								)}
							</div>
						),
					},
					{
						key: "source",
						header: "Source",
						cell: (row) =>
							row.source === "stream" ? (
								<div className="flex flex-col gap-1">
									<Badge tone="accent">Stream</Badge>
									{row.streamUri === null ? null : (
										<span className="max-w-64 truncate text-xs text-muted-foreground">
											{row.streamUri}
										</span>
									)}
								</div>
							) : (
								<Badge tone="neutral">Library</Badge>
							),
					},
					{
						key: "sampleRateHz",
						header: "Sample rate",
						className: "whitespace-nowrap",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.sampleRateHz.toLocaleString()} Hz
							</span>
						),
					},
					{
						key: "isDefault",
						header: "Default",
						cell: (row) => (row.isDefault ? <Badge tone="success">Default</Badge> : "—"),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`hold music class ${row.name}`}
						extra={
							canRead ? <MenuItem onClick={() => setFilesFor(row)}>Files…</MenuItem> : null
						}
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

			<MohClassDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				mohClass={editing}
			/>

			{/*
			 * Keyed by the class, for the reason the mailbox message dialog is: opening a second class
			 * must not show the first one's files for the frame it takes the new query to resolve.
			 */}
			<MohFilesDialog
				key={`files-${filesFor?.id ?? "none"}`}
				open={filesFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setFilesFor(null);
					}
				}}
				mohClass={filesFor}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="hold music class"
				entityName={pendingDelete ? pendingDelete.name : "this class"}
				description="The class and the audio uploaded into it are removed. Anything that plays it — a queue, a parking lot, a transfer — must be pointed at another class first; the delete is refused while anything still names it."
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
