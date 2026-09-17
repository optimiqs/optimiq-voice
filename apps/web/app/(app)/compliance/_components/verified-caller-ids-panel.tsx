"use client";

import { useId, useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { ListPagination, ResourceTable, useListQueryState } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { inputClassName } from "~/components/ui/field";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { VerifiedCallerIdDialog } from "./verified-caller-id-dialog";
import type { CallerIdVerificationMethod, VerifiedCallerIdRow } from "~/lib/pbx/contracts";

/**
 * The external numbers this organization may present as caller ID.
 *
 * Not the numbers it OWNS — those are on `/numbers` and need no evidence, because the platform
 * assigned them. This list is the second half of the same question: a number somebody else is
 * billed for, which this organization has been authorised to call out on.
 *
 * The expiry is a column rather than a detail, and that is the panel's whole job. A verification
 * that lapsed is not a lapsed row: the number keeps working and the attestation on every call
 * presenting it quietly drops, which is exactly the kind of failure nobody notices until a carrier
 * asks. So an expired row says so, in the colour of a problem.
 */
const METHOD_LABELS: Readonly<Record<CallerIdVerificationMethod, string>> = {
	document: "Document",
	"call-back": "Call-back",
	"carrier-loa": "Carrier LOA",
};

function expiryCell(row: VerifiedCallerIdRow) {
	if (row.expiresAt === null) {
		return <span className="text-sm text-muted-foreground">Does not lapse</span>;
	}
	const expired = new Date(row.expiresAt).getTime() < Date.now();
	return (
		<Badge tone={expired ? "danger" : "neutral"}>
			{expired ? "Expired " : ""}
			{new Date(row.expiresAt).toLocaleDateString()}
		</Badge>
	);
}

export function VerifiedCallerIdsPanel() {
	const resource = PBX_RESOURCES.verifiedCallerIds;
	const { query, search, setSearch, page, setPage } = useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);
	const searchId = useId();

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<VerifiedCallerIdRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<VerifiedCallerIdRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			Add caller ID
		</Button>
	) : null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<p className="max-w-2xl text-sm text-muted-foreground">
					Numbers this organization does not own but has been authorised to present. Each one needs
					evidence behind it — that evidence is what lets an outbound call be attested B instead of
					C.
				</p>
				{createButton}
			</div>

			{/*
			 * A bare search box rather than the shared `ListToolbar`, on the precedent the emergency
			 * addresses screen sets: the toolbar also renders an enabled/disabled filter, and a verified
			 * caller ID has no `enabled` column — it is verified, expired, or absent. A filter that
			 * cannot change the result is worse than no filter, because somebody will use it and
			 * conclude the list is broken.
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
						placeholder="Number or label"
						className={inputClassName}
					/>
				</div>
			</div>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0}
				emptyTitle="No verified caller IDs"
				emptyDescription="Add a number once you hold a letter of authorisation, a bill, or a confirmed call-back code for it. Without one, outbound policy decides what happens to a call that tries to present it."
				emptyAction={createButton}
				caption="Verified caller IDs in this organization"
				columns={[
					{
						key: "e164",
						header: "Number",
						className: "font-mono whitespace-nowrap",
						cell: (row) => row.e164,
					},
					{ key: "label", header: "Label", cell: (row) => row.label ?? "—" },
					{
						key: "verificationMethod",
						header: "Verified by",
						cell: (row) => METHOD_LABELS[row.verificationMethod],
					},
					{
						key: "verificationReference",
						header: "Reference",
						className: "font-mono",
						cell: (row) => row.verificationReference ?? "—",
					},
					{
						key: "verifiedAt",
						header: "On",
						cell: (row) =>
							row.verifiedAt === null ? "—" : new Date(row.verifiedAt).toLocaleDateString(),
					},
					{ key: "expiresAt", header: "Expires", cell: expiryCell },
				]}
				rowActions={(row) => (
					<RowActions
						label={`verified caller ID ${row.e164}`}
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

			<VerifiedCallerIdDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				callerId={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="verified caller ID"
				entityName={pendingDelete ? pendingDelete.e164 : "this caller ID"}
				description="Calls presenting this number stop being treated as verified. What happens to them next is decided by the outbound policy on this page — they may be allowed through unattested, replaced, or refused."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</div>
	);
}
