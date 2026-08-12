"use client";

import Link from "next/link";
import { useState } from "react";
import { ChildCollectionCard } from "~/components/pbx/child-collection";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { Badge } from "~/components/ui/badge";
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
	usePbxList,
} from "../../_hooks/use-pbx-queries";
import { SharedLineAppearanceDialog } from "./shared-line-appearance-dialog";
import { SharedLineDialog } from "./shared-line-dialog";
import type { ExtensionRow, SharedLineAppearanceRow, SharedLineRow } from "~/lib/pbx/contracts";

/** How the appearances are offered a call to the line's number. */
const STRATEGY_DESCRIPTIONS: Readonly<Record<SharedLineRow["strategy"], string>> = {
	simultaneous: "rings every appearance at once",
	sequential: "walks the appearances in button order",
};

/**
 * One shared line and the appearances that light on it.
 *
 * ## The reorder is a whole-list write, not a swap
 *
 * Move up / Move down send the COMPLETE list of ids in their new order to `PUT …/appearances/reorder`,
 * because that is what the endpoint takes: `(line, ordinal)` is unique, so most of the intermediate
 * states a sequence of PATCHes would pass through are not even writable, and each one that was would
 * renumber the buttons and publish another layout to the routing cache. One request, one transaction,
 * one published order. The ordinal here is the button INDEX a phone lights, so a reorder is a
 * renumbering rather than a cosmetic sort — which is exactly why it is worth doing atomically.
 *
 * There is no optimistic swap. The reply carries the collection as the server stored it, and the
 * invalidation is what puts it on screen — a server that refuses the permutation (a stale editor, an
 * appearance deleted from another session) must not have left a rearranged list on this one.
 *
 * ## An empty line is a warning, not an error
 *
 * A line with no enabled appearances saves and compiles, and lights nobody's button. There is no
 * timeout destination for a call to fall into — the line simply is a key that nobody holds — so the
 * panel says so permanently rather than only in whichever toast happened to follow the last save.
 */
export function SharedLineDetail({ lineId }: { lineId: string }) {
	const line = usePbxItem(PBX_RESOURCES.sharedLines, lineId);
	const appearances = usePbxChildren(PBX_CHILDREN.sharedLineAppearances, "shared-lines", lineId);
	const removeAppearance = usePbxChildDelete(
		PBX_CHILDREN.sharedLineAppearances,
		"shared-lines",
		lineId,
	);
	const reorder = usePbxChildReorder(PBX_CHILDREN.sharedLineAppearances, "shared-lines", lineId);

	/** Appearances carry an extension id; the table has to say a number. Capped at the API's page size. */
	const extensions = usePbxList(PBX_RESOURCES.extensions, { page: 1, limit: 100 });
	const extensionsById = new Map(extensions.rows.map((row: ExtensionRow) => [row.id, row]));

	const canWrite = usePermission(PBX_RESOURCES.sharedLines.permissions.write);

	const [lineDialogOpen, setLineDialogOpen] = useState(false);
	const [editingAppearance, setEditingAppearance] = useState<SharedLineAppearanceRow | null>(null);
	const [appearanceDialogOpen, setAppearanceDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<SharedLineAppearanceRow | null>(null);

	if (line.isPending) {
		return <LoadingPanel label="Loading shared line" />;
	}

	if (line.error instanceof ApiError && line.error.status === 404) {
		return (
			<EmptyState
				title="This shared line no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.sharedLines} />} variant="secondary">
						Back to shared lines
					</Button>
				}
			/>
		);
	}

	if (!line.data) {
		return (
			<EmptyState
				title="Could not load this shared line"
				description={line.error instanceof Error ? line.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = line.data as SharedLineRow;
	const rows = [...(appearances.data ?? [])].sort(
		(a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
	);
	const nextOrdinal = rows.reduce(
		(highest, appearance) => Math.max(highest, appearance.ordinal + 1),
		0,
	);
	const activeAppearances = rows.filter((appearance) => appearance.enabled);

	/**
	 * Swaps two positions and sends the whole list. `index` is the position in the SORTED list, so the
	 * ids leaving here are already in the order the server is being asked to store.
	 */
	function move(index: number, delta: number): void {
		const next = [...rows];
		const target = index + delta;
		const current = next[index];
		const swap = next[target];
		if (current === undefined || swap === undefined) {
			return;
		}
		next[index] = swap;
		next[target] = current;
		reorder.mutate(next.map((appearance) => appearance.id));
	}

	function appearanceLabel(appearance: SharedLineAppearanceRow): string {
		const extension = extensionsById.get(appearance.extensionId);
		return extension
			? PBX_RESOURCES.extensions.displayName(extension)
			: `${appearance.extensionId.slice(0, 8)}…`;
	}

	return (
		<>
			<PageHeader
				title={row.name}
				description={`A shared line on ${rows.length} appearance${rows.length === 1 ? "" : "s"}${
					row.extensionNumber
						? `, dialable on ${row.extensionNumber}`
						: ", reached through its buttons"
				}. A call to it ${STRATEGY_DESCRIPTIONS[row.strategy]}; a held call ${
					row.holdRecallTimeoutSeconds === 0
						? "is held indefinitely"
						: `recalls after ${row.holdRecallTimeoutSeconds}s`
				}.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.sharedLines} />} variant="ghost">
							All lines
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setLineDialogOpen(true)}>
								Line settings
							</Button>
						) : null}
					</div>
				}
			/>

			{!appearances.isPending && activeAppearances.length === 0 ? (
				<NoticeBanner
					title="Lights nobody's button"
					description={
						rows.length === 0
							? "This line has no appearances, so it is a key nobody holds. Unlike a ring group there is no timeout destination to fall into — the line simply lights no lamps. Add the extensions whose buttons it should light."
							: "Every appearance on this line is disabled, so it lights nobody's button."
					}
				/>
			) : null}

			{row.bargeInEnabled ? (
				<NoticeBanner
					title="Barge-in is on — but not yet acting"
					description="This line is configured to let an idle appearance join a call already up on it. The flag is stored and compiled, but the live media join awaits the media plane, so no call joins on it today. Turn it off in Line settings if that intent is not what you meant to record."
				/>
			) : null}

			<ChildCollectionCard
				title="Appearances"
				description="The handsets that light a button for this line, in the order the buttons are numbered. An appearance is an extension, not a destination — the engine lights a lamp on a registered handset, and only a registered endpoint has one."
				rows={rows}
				isPending={appearances.isPending || extensions.query.isPending}
				emptyTitle="No appearances yet"
				emptyDescription="Add the extensions whose buttons this line should light. One button per extension — a desk cannot hold two buttons on the same line."
				addLabel="Add appearance"
				onAdd={
					canWrite
						? () => {
								setEditingAppearance(null);
								setAppearanceDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "extension",
						header: "Handset",
						className: "font-medium",
						cell: (appearance) => appearanceLabel(appearance),
					},
					{
						key: "ordinal",
						header: "Button",
						cell: (appearance) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{appearance.ordinal}
							</span>
						),
					},
					{
						key: "missing",
						header: "Resolves",
						/**
						 * An extension the list does not hold is worth a badge rather than a blank. The
						 * foreign key cascades on delete, so this is almost always the 100-row cap rather than
						 * a dangling appearance — but "we did not fetch it" and "it is not there" look
						 * identical in a name column, and only one of them is fine.
						 */
						cell: (appearance) =>
							extensionsById.has(appearance.extensionId) ? (
								<Badge tone="neutral">extension</Badge>
							) : (
								<span className="text-xs text-muted-foreground">
									Not in the first {extensions.rows.length}
								</span>
							),
					},
					{
						key: "enabled",
						header: "State",
						cell: (appearance) => <EnabledBadge enabled={appearance.enabled} />,
					},
				]}
				rowActions={(appearance) => {
					const index = rows.findIndex((candidate) => candidate.id === appearance.id);
					return (
						<RowActions
							label={`appearance ${appearanceLabel(appearance)}`}
							extra={
								canWrite && rows.length > 1 ? (
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
								) : undefined
							}
							onEdit={
								canWrite
									? () => {
											setEditingAppearance(appearance);
											setAppearanceDialogOpen(true);
										}
									: undefined
							}
							onDelete={
								canWrite
									? () => {
											removeAppearance.reset();
											setPendingDelete(appearance);
										}
									: undefined
							}
						/>
					);
				}}
				footer={
					rows.length > 1 ? (
						<p className="text-xs text-muted-foreground">
							Move up and Move down rewrite the whole order in one request, because the ordinal is
							the button position a phone lights and two appearances cannot share one. Renumbering
							the buttons is one transaction, not a per-row shuffle.
						</p>
					) : undefined
				}
			/>

			<SharedLineDialog open={lineDialogOpen} onOpenChange={setLineDialogOpen} line={row} />

			<SharedLineAppearanceDialog
				key={editingAppearance?.id ?? `new-${nextOrdinal}`}
				open={appearanceDialogOpen}
				onOpenChange={setAppearanceDialogOpen}
				lineId={lineId}
				appearance={editingAppearance}
				nextOrdinal={nextOrdinal}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeAppearance.reset();
					}
				}}
				entityLabel="appearance"
				entityName={pendingDelete ? appearanceLabel(pendingDelete) : "this appearance"}
				description="The extension itself is untouched — its button simply stops lighting for this line."
				pending={removeAppearance.isPending}
				error={removeAppearance.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeAppearance.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
