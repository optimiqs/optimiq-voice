"use client";

import Link from "next/link";
import { useState } from "react";
import { ChildCollectionCard } from "~/components/pbx/child-collection";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { MenuItem } from "~/components/ui/menu";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import {
	usePbxChildDelete,
	usePbxChildReorder,
	usePbxChildren,
	usePbxItem,
} from "../../_hooks/use-pbx-queries";
import { PinSetCodeDialog } from "./pin-set-code-dialog";
import { PinSetDialog } from "./pin-set-dialog";
import { PinSetEntryDialog } from "./pin-set-entry-dialog";
import type { PinSetEntryRow, PinSetRow } from "~/lib/pbx/contracts";

/**
 * One PIN set and the codes in it.
 *
 * ## There is no column showing a code, and there is no way to add one
 *
 * `pin_hash` is in `secretColumns` on the server's child resource, so it is stripped from every
 * response — a row simply does not carry it. There is no "show me the code" endpoint either, and
 * there should not be: a four-digit PIN behind scrypt is a few CPU-seconds of work once the digest
 * is in hand, which is exactly why upstream's plaintext column was the thing this feature had to
 * change. What this page can say is which codes exist, who holds them and what a call record will
 * name — and that is the whole of what a plaintext column was ever needed for.
 *
 * ## The order is an identity, not a preference
 *
 * `ordinal` is what a call detail record records ("authorised by code 3"), so Move up and Move down
 * re-label history as well as re-ordering a table. The panel says so, because "drag to taste" is the
 * assumption every other ordered list in this app has trained.
 */
export function PinSetDetail({ pinSetId }: { pinSetId: string }) {
	const pinSet = usePbxItem(PBX_RESOURCES.pinSets, pinSetId);
	const entries = usePbxChildren(PBX_CHILDREN.pinSetEntries, "pin-sets", pinSetId);
	const removeEntry = usePbxChildDelete(PBX_CHILDREN.pinSetEntries, "pin-sets", pinSetId);
	const reorder = usePbxChildReorder(PBX_CHILDREN.pinSetEntries, "pin-sets", pinSetId);

	const canWrite = usePermission(PBX_RESOURCES.pinSets.permissions.write);
	const canDelete = usePermission(PBX_RESOURCES.pinSets.permissions.delete);

	const [setDialogOpen, setSetDialogOpen] = useState(false);
	const [editingEntry, setEditingEntry] = useState<PinSetEntryRow | null>(null);
	const [entryDialogOpen, setEntryDialogOpen] = useState(false);
	const [codeEntry, setCodeEntry] = useState<PinSetEntryRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<PinSetEntryRow | null>(null);

	if (pinSet.isPending) {
		return <LoadingPanel label="Loading PIN set" />;
	}

	if (pinSet.error instanceof ApiError && pinSet.error.status === 404) {
		return (
			<EmptyState
				title="This PIN set no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.pinSets} />} variant="secondary">
						Back to authorisation codes
					</Button>
				}
			/>
		);
	}

	if (!pinSet.data) {
		return (
			<EmptyState
				title="Could not load this PIN set"
				description={
					pinSet.error instanceof Error ? pinSet.error.message : "Try again in a moment."
				}
			/>
		);
	}

	const row = pinSet.data as PinSetRow;
	const rows = entries.data ?? [];
	const nextOrdinal = rows.reduce((highest, entry) => Math.max(highest, entry.ordinal + 1), 0);
	const activeEntries = rows.filter((entry) => entry.enabled);

	function move(index: number, delta: -1 | 1): void {
		const target = index + delta;
		if (target < 0 || target >= rows.length) {
			return;
		}
		const next = [...rows];
		const current = next[index];
		const swap = next[target];
		if (current === undefined || swap === undefined) {
			return;
		}
		next[index] = swap;
		next[target] = current;
		reorder.mutate(next.map((entry) => entry.id));
	}

	return (
		<>
			<PageHeader
				title={row.name}
				description={
					row.description ??
					`Callers get ${row.maxAttempts} attempt${row.maxAttempts === 1 ? "" : "s"}, with ${row.digitTimeoutMs} ms between keypresses.`
				}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.pinSets} />} variant="ghost">
							All sets
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setSetDialogOpen(true)}>
								Set settings
							</Button>
						) : null}
					</div>
				}
			/>

			{!entries.isPending && activeEntries.length === 0 ? (
				<NoticeBanner
					title="Nobody can get through"
					description={
						rows.length === 0
							? "This set has no codes, so every caller challenged by it is refused. A route gated by an empty set cannot be dialled at all."
							: "Every code in this set is disabled, so every caller challenged by it is refused."
					}
				/>
			) : null}

			<ChildCollectionCard
				title="Codes"
				description="Each row is one code. The digits are not stored in a form anything can read them back from — only the position and the label, which is what a call record names."
				rows={rows}
				isPending={entries.isPending}
				emptyTitle="No codes yet"
				emptyDescription="Add the first code. It is set at the same moment the row is created — a code with no digits is dropped by the compiler with a warning, so there is no half-configured state to leave behind."
				addLabel="Add code"
				onAdd={
					canWrite
						? () => {
								setEditingEntry(null);
								setEntryDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "ordinal",
						header: "Position",
						className: "font-medium",
						cell: (entry) => <span data-tabular>{entry.ordinal}</span>,
					},
					{ key: "label", header: "Held by", cell: (entry) => entry.label ?? "—" },
					{
						key: "digits",
						header: "Digits",
						cell: () => <span className="text-sm text-muted-foreground">Not readable</span>,
					},
					{
						key: "enabled",
						header: "State",
						cell: (entry) => <EnabledBadge enabled={entry.enabled} />,
					},
				]}
				rowActions={(entry) => {
					const index = rows.findIndex((candidate) => candidate.id === entry.id);
					return (
						<RowActions
							label={entry.label ?? `code ${entry.ordinal}`}
							extra={
								canWrite ? (
									<>
										<MenuItem onClick={() => setCodeEntry(entry)}>Replace the code</MenuItem>
										{rows.length > 1 ? (
											<>
												<MenuItem
													disabled={index <= 0 || reorder.isPending}
													onClick={() => move(index, -1)}
												>
													Move up
												</MenuItem>
												<MenuItem
													disabled={index === rows.length - 1 || reorder.isPending}
													onClick={() => move(index, 1)}
												>
													Move down
												</MenuItem>
											</>
										) : null}
									</>
								) : undefined
							}
							onEdit={
								canWrite
									? () => {
											setEditingEntry(entry);
											setEntryDialogOpen(true);
										}
									: undefined
							}
							onDelete={
								canDelete
									? () => {
											removeEntry.reset();
											setPendingDelete(entry);
										}
									: undefined
							}
						/>
					);
				}}
				footer={
					<p className="text-xs text-muted-foreground">
						A position is an identity, not a sort order: call records name the code by it, so moving
						a code changes what past calls appear to have been authorised by. Disable a retired code
						rather than deleting it if that history matters.
					</p>
				}
			/>

			<PinSetDialog open={setDialogOpen} onOpenChange={setSetDialogOpen} pinSet={row} />

			<PinSetEntryDialog
				key={editingEntry?.id ?? `new-${nextOrdinal}`}
				open={entryDialogOpen}
				onOpenChange={setEntryDialogOpen}
				pinSetId={pinSetId}
				entry={editingEntry}
				nextOrdinal={nextOrdinal}
			/>

			<PinSetCodeDialog
				key={codeEntry?.id ?? "none"}
				open={codeEntry !== null}
				onOpenChange={(open) => {
					if (!open) {
						setCodeEntry(null);
					}
				}}
				pinSetId={pinSetId}
				entry={codeEntry}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeEntry.reset();
					}
				}}
				entityLabel="code"
				entityName={pendingDelete?.label ?? "this code"}
				description="Whoever holds it stops getting through. Past call records that name this position will no longer resolve to a code — disable it instead if that matters."
				pending={removeEntry.isPending}
				error={removeEntry.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeEntry.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
