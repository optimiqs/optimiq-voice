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
import { PagingGroupDialog } from "./paging-group-dialog";
import { PagingGroupMemberDialog } from "./paging-group-member-dialog";
import type { ExtensionRow, PagingGroupMemberRow, PagingGroupRow } from "~/lib/pbx/contracts";

/**
 * One paging group and the handsets it reaches.
 *
 * ## The reorder is a whole-list write, not a swap
 *
 * Move up / Move down send the COMPLETE list of ids in their new order to `PUT …/members/reorder`,
 * because that is what the endpoint takes: `(group, ordinal)` is unique, so most of the intermediate
 * states a sequence of PATCHes would pass through are not even writable, and each one that was would
 * publish another order to the routing cache. One request, one transaction, one published order.
 *
 * There is no optimistic swap. The reply carries the collection as the server stored it, and the
 * invalidation is what puts it on screen — a server that refuses the permutation (a stale editor,
 * a member deleted from another session) must not have left a rearranged list on this one.
 *
 * ## An empty group is a warning, not an error
 *
 * A group with no enabled members saves and compiles, and announces to nobody. Unlike a ring group
 * there is no timeout destination for the call to fall into afterwards — the page simply reaches
 * no one and ends — so the panel says so permanently rather than only in whichever toast happened
 * to follow the last save.
 */
export function PagingGroupDetail({ groupId }: { groupId: string }) {
	const group = usePbxItem(PBX_RESOURCES.pagingGroups, groupId);
	const members = usePbxChildren(PBX_CHILDREN.pagingGroupMembers, "paging-groups", groupId);
	const removeMember = usePbxChildDelete(PBX_CHILDREN.pagingGroupMembers, "paging-groups", groupId);
	const reorder = usePbxChildReorder(PBX_CHILDREN.pagingGroupMembers, "paging-groups", groupId);

	/** Members carry an extension id; the table has to say a number. Capped at the API's page size. */
	const extensions = usePbxList(PBX_RESOURCES.extensions, { page: 1, limit: 100 });
	const extensionsById = new Map(extensions.rows.map((row: ExtensionRow) => [row.id, row]));

	const canWrite = usePermission(PBX_RESOURCES.pagingGroups.permissions.write);

	const [groupDialogOpen, setGroupDialogOpen] = useState(false);
	const [editingMember, setEditingMember] = useState<PagingGroupMemberRow | null>(null);
	const [memberDialogOpen, setMemberDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<PagingGroupMemberRow | null>(null);

	if (group.isPending) {
		return <LoadingPanel label="Loading paging group" />;
	}

	if (group.error instanceof ApiError && group.error.status === 404) {
		return (
			<EmptyState
				title="This paging group no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.pagingGroups} />} variant="secondary">
						Back to paging groups
					</Button>
				}
			/>
		);
	}

	if (!group.data) {
		return (
			<EmptyState
				title="Could not load this paging group"
				description={group.error instanceof Error ? group.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = group.data as PagingGroupRow;
	const rows = [...(members.data ?? [])].sort(
		(a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
	);
	const nextOrdinal = rows.reduce((highest, member) => Math.max(highest, member.ordinal + 1), 0);
	const activeMembers = rows.filter((member) => member.enabled);

	/**
	 * Swaps two positions and sends the whole list. `index` is the position in the SORTED list, so
	 * the ids leaving here are already in the order the server is being asked to store.
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
		reorder.mutate(next.map((member) => member.id));
	}

	function memberLabel(member: PagingGroupMemberRow): string {
		const extension = extensionsById.get(member.extensionId);
		return extension
			? PBX_RESOURCES.extensions.displayName(extension)
			: `${member.extensionId.slice(0, 8)}…`;
	}

	return (
		<>
			<PageHeader
				title={row.name}
				description={`${
					row.duplex ? "Talkback intercom" : "One-way announcement"
				} to ${rows.length} handset${rows.length === 1 ? "" : "s"}${
					row.extensionNumber ? `, dialable on ${row.extensionNumber}` : ", reachable through *81"
				}. Each handset is given ${row.timeoutSeconds} seconds to auto-answer.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.pagingGroups} />} variant="ghost">
							All groups
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setGroupDialogOpen(true)}>
								Group settings
							</Button>
						) : null}
					</div>
				}
			/>

			{!members.isPending && activeMembers.length === 0 ? (
				<NoticeBanner
					title="Announces to nobody"
					description={
						rows.length === 0
							? "This group has no members, so a page reaching it is silence. Unlike a ring group there is no timeout destination to fall into — the announcement simply reaches no one and ends. Add the extensions it should reach, or re-point whatever sends calls here."
							: "Every member of this group is disabled, so a page reaching it announces to nobody."
					}
				/>
			) : null}

			{row.duplex ? (
				<NoticeBanner
					title="Talkback is on"
					description="Every member's microphone is open for the whole announcement and they can all hear each other. That is what an intercom is for; on a large group it is a roomful of open microphones. Turn it off in Group settings to make this a one-way page."
				/>
			) : null}

			<ChildCollectionCard
				title="Members"
				description="The handsets this group announces to, in the order the fan-out reaches them. A member is an extension, not a destination — the engine auto-answers a leg to each one, and only a registered endpoint can be told to pick up."
				rows={rows}
				isPending={members.isPending || extensions.query.isPending}
				emptyTitle="No members yet"
				emptyDescription="Add the extensions this group should announce to. Each handset must also be configured to auto-answer, which is a phone setting rather than one this page can make."
				addLabel="Add member"
				onAdd={
					canWrite
						? () => {
								setEditingMember(null);
								setMemberDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "extension",
						header: "Handset",
						className: "font-medium",
						cell: (member) => memberLabel(member),
					},
					{
						key: "ordinal",
						header: "Order",
						cell: (member) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{member.ordinal}
							</span>
						),
					},
					{
						key: "missing",
						header: "Resolves",
						/**
						 * An extension the list does not hold is worth a badge rather than a blank. The
						 * foreign key cascades on delete, so this is almost always the 100-row cap rather
						 * than a dangling member — but "we did not fetch it" and "it is not there" look
						 * identical in a name column, and only one of them is fine.
						 */
						cell: (member) =>
							extensionsById.has(member.extensionId) ? (
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
						cell: (member) => <EnabledBadge enabled={member.enabled} />,
					},
				]}
				rowActions={(member) => {
					const index = rows.findIndex((candidate) => candidate.id === member.id);
					return (
						<RowActions
							label={`member ${memberLabel(member)}`}
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
											setEditingMember(member);
											setMemberDialogOpen(true);
										}
									: undefined
							}
							onDelete={
								canWrite
									? () => {
											removeMember.reset();
											setPendingDelete(member);
										}
									: undefined
							}
						/>
					);
				}}
				footer={
					rows.length > 1 ? (
						<p className="text-xs text-muted-foreground">
							Move up and Move down rewrite the whole order in one request, because two members
							cannot share a position. A page to a hundred desks is fanned out rather than
							originated in one instant, which is what makes this order worth setting.
						</p>
					) : undefined
				}
			/>

			<PagingGroupDialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen} group={row} />

			<PagingGroupMemberDialog
				key={editingMember?.id ?? `new-${nextOrdinal}`}
				open={memberDialogOpen}
				onOpenChange={setMemberDialogOpen}
				groupId={groupId}
				member={editingMember}
				nextOrdinal={nextOrdinal}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeMember.reset();
					}
				}}
				entityLabel="member"
				entityName={pendingDelete ? memberLabel(pendingDelete) : "this member"}
				description="The extension itself is untouched — it simply stops being reached by this group's announcements."
				pending={removeMember.isPending}
				error={removeMember.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeMember.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
