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
import { followMeSummary } from "~/lib/pbx/follow-me";
import { usePermission } from "../../_context/session-context";
import { useLiveRegistrations } from "../../_hooks/use-live-queries";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { ExtensionDialog } from "./extension-dialog";
import type { ExtensionRow } from "~/lib/pbx/contracts";

/**
 * Extensions: the list, the create/edit dialog and the delete confirmation.
 *
 * Deleting an extension is the delete most likely to be refused. Every ring-group member, IVR
 * option and DID that points here holds a `destination_ref` with no foreign key behind it, so the
 * API scans for referrers and answers 409 with their names — which the confirmation renders as
 * links rather than as a failure message.
 *
 * ## The Registered column is LIVE, and belongs here rather than on a page of its own
 *
 * A registration binds an AOR — which is an extension — to a contact, so "which of my phones are
 * online" is a column of this table and not a separate screen. It is streamed from the
 * `registrations` KV bucket over `/api/v1/live`, so it changes as phones come and go rather than on
 * a refresh, and it is gated on `extensions.read` exactly as this page is: a caller who can see the
 * list can see which of them are up.
 *
 * A binding is only shown as registered if its GRANTED interval has not lapsed. The bucket's TTL is
 * an hour and a device's `Expires:` is minutes, so an entry can be present and long dead — a column
 * that read presence as "registered" would show an unplugged phone as online for the rest of the
 * hour, which is the exact opposite of what an operator opens this page to find out.
 */
export function ExtensionsScreen() {
	const resource = PBX_RESOURCES.extensions;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);
	const registrations = useLiveRegistrations();

	const [editing, setEditing] = useState<ExtensionRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<ExtensionRow | null>(null);

	function openCreate(): void {
		setEditing(null);
		setDialogOpen(true);
	}

	function openEdit(row: ExtensionRow): void {
		setEditing(row);
		setDialogOpen(true);
	}

	const createButton = canWrite ? (
		<Button variant="primary" onClick={openCreate}>
			New extension
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Extensions"
				description="Internal endpoints: what each one dials as, what it may dial, and where its calls go when nobody answers."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Number or name"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No extensions yet"
				emptyDescription="An extension is an internal endpoint — a desk phone, a softphone, or a place a route can send a call."
				emptyAction={createButton}
				caption="Extensions in this organization"
				columns={[
					{
						key: "number",
						header: "Number",
						className: "font-medium whitespace-nowrap",
						cell: (row) => row.number,
					},
					{
						key: "label",
						header: "Name",
						cell: (row) => (
							<div className="flex flex-col">
								<span>{row.label}</span>
								{row.callerIdNumber && row.callerIdNumber !== row.number ? (
									<span className="text-xs text-muted-foreground">
										Caller ID {row.callerIdNumber}
									</span>
								) : null}
							</div>
						),
					},
					{
						key: "tollClass",
						header: "Toll class",
						cell: (row) => <Badge tone="neutral">{row.tollClass}</Badge>,
					},
					{
						key: "features",
						header: "Features",
						cell: (row) => {
							/**
							 * Only an ACTIVE ladder is badged. A stored-but-disabled one changes nothing
							 * about where a call goes, and saying so here would tell an operator their
							 * calls are being chased when they are not — see `followMeSummary`.
							 */
							const followMe = followMeSummary(row.followMe);
							return (
								<div className="flex flex-wrap gap-1">
									{row.voicemailEnabled ? <Badge tone="accent">Voicemail</Badge> : null}
									{row.doNotDisturb ? <Badge tone="warning">DND</Badge> : null}
									{followMe ? <Badge tone="accent">{followMe}</Badge> : null}
									{row.recordPolicy !== "none" ? (
										<Badge tone="neutral">Rec: {row.recordPolicy}</Badge>
									) : null}
								</div>
							);
						},
					},
					{
						key: "registered",
						header: "Registered",
						cell: (row) => {
							if (!registrations.loaded) {
								// Not loaded is not "offline". Painting every phone as unregistered for
								// the half second before the snapshot lands would be a confidently wrong
								// answer to the one question this column exists for.
								return <span className="text-xs text-subtle-foreground">—</span>;
							}
							const binding = registrations.byExtensionId.get(row.id);
							return binding === undefined ? (
								<Badge tone="neutral">Offline</Badge>
							) : (
								<div className="flex flex-col gap-0.5">
									<Badge tone="success">Online</Badge>
									{binding.userAgent ? (
										<span className="max-w-40 truncate text-xs text-muted-foreground">
											{binding.userAgent}
										</span>
									) : null}
								</div>
							);
						},
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`extension ${row.number}`}
						onEdit={canWrite ? () => openEdit(row) : undefined}
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

			{/*
			 * Keyed by the row being edited so switching straight from one row to another remounts the
			 * form with the new defaults. TanStack Form captures `defaultValues` at mount, so without
			 * this the second row would open showing the first row's values.
			 */}
			<ExtensionDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				extension={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="extension"
				entityName={pendingDelete ? `extension ${pendingDelete.number}` : "this extension"}
				description="The extension stops registering immediately. Its call history and recordings are kept. Anything that routes calls here must be re-pointed first — the delete is refused, not cascaded, if it would leave a route pointing at nothing."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, {
						onSuccess: () => setPendingDelete(null),
					});
				}}
			/>
		</>
	);
}
