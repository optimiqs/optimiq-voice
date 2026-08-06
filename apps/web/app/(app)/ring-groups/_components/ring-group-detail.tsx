"use client";

import Link from "next/link";
import { useState } from "react";
import { ChildCollectionCard } from "~/components/pbx/child-collection";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { WarningsBanner } from "~/components/pbx/warnings-banner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxChildDelete, usePbxChildren, usePbxItem } from "../../_hooks/use-pbx-queries";
import { RingGroupDialog } from "./ring-group-dialog";
import { RingGroupMemberDialog } from "./ring-group-member-dialog";
import type { RingGroupMemberRow, RingGroupRow } from "~/lib/pbx/contracts";

/**
 * One ring group and its members.
 *
 * An empty group is the canonical WARNING case in this API: it saves, it compiles, and it rings
 * nobody. The compiler says so on every write, so this page says so too — permanently, in the
 * panel, rather than only in the toast that followed whichever save happened to touch it.
 */
export function RingGroupDetail({ groupId }: { groupId: string }) {
	const group = usePbxItem(PBX_RESOURCES.ringGroups, groupId);
	const members = usePbxChildren(PBX_CHILDREN.ringGroupMembers, "ring-groups", groupId);
	const removeMember = usePbxChildDelete(PBX_CHILDREN.ringGroupMembers, "ring-groups", groupId);

	const canWrite = usePermission(PBX_RESOURCES.ringGroups.permissions.write);

	const [groupDialogOpen, setGroupDialogOpen] = useState(false);
	const [editingMember, setEditingMember] = useState<RingGroupMemberRow | null>(null);
	const [memberDialogOpen, setMemberDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<RingGroupMemberRow | null>(null);

	if (group.isPending) {
		return <LoadingPanel label="Loading ring group" />;
	}

	if (group.error instanceof ApiError && group.error.status === 404) {
		return (
			<EmptyState
				title="This ring group no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.ringGroups} />} variant="secondary">
						Back to ring groups
					</Button>
				}
			/>
		);
	}

	if (!group.data) {
		return (
			<EmptyState
				title="Could not load this ring group"
				description={group.error instanceof Error ? group.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = group.data as RingGroupRow;
	const rows = members.data ?? [];
	const nextOrdinal = rows.reduce((highest, member) => Math.max(highest, member.ordinal + 1), 0);
	const activeMembers = rows.filter((member) => member.enabled);

	return (
		<>
			<PageHeader
				title={row.name}
				description={`Rings ${row.strategy === "simultaneous" ? "everyone at once" : "one member after another"} for ${row.ringTimeoutSeconds} seconds, then goes to ${describeDestination(
					readDestination(row as unknown as Record<string, unknown>, "timeout"),
				).toLowerCase()}.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.ringGroups} />} variant="ghost">
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
				<WarningsBanner
					title="Rings nobody"
					description="This group has no enabled members, so a call reaching it waits out the ring time and then takes the timeout destination. The routing compiler reports this on every save."
					warnings={[
						{
							severity: "warning",
							code: "empty-ring-group",
							message:
								rows.length === 0
									? "Add at least one member, or point whatever routes calls here somewhere else."
									: "Every member of this group is disabled.",
							subject: { kind: "ring-group", id: row.id, name: row.name },
						},
					]}
				/>
			) : null}

			<ChildCollectionCard
				title="Members"
				description="Who this group rings. A member is a destination, so a group can ring a mobile or another group."
				rows={rows}
				isPending={members.isPending}
				emptyTitle="No members yet"
				emptyDescription="Add the extensions — or numbers, or other groups — this group should ring."
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
						key: "destination",
						header: "Rings",
						className: "font-medium",
						cell: (member) =>
							describeDestination(
								readDestination(member as unknown as Record<string, unknown>, ""),
							),
					},
					{
						key: "timing",
						header: "Timing",
						cell: (member) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{member.delaySeconds > 0 ? `starts at +${member.delaySeconds}s, ` : ""}
								rings {member.timeoutSeconds}s
							</span>
						),
					},
					{
						key: "confirm",
						header: "Confirm",
						cell: (member) =>
							member.confirmRequired ? <Badge tone="accent">Required</Badge> : "—",
					},
					{ key: "ordinal", header: "Order", cell: (member) => member.ordinal },
					{
						key: "enabled",
						header: "State",
						cell: (member) => <EnabledBadge enabled={member.enabled} />,
					},
				]}
				rowActions={(member) => (
					<RowActions
						label={`member ${member.ordinal + 1}`}
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
				)}
			/>

			<RingGroupDialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen} group={row} />

			<RingGroupMemberDialog
				key={editingMember?.id ?? `new-${nextOrdinal}`}
				open={memberDialogOpen}
				onOpenChange={setMemberDialogOpen}
				groupId={groupId}
				strategy={row.strategy}
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
				entityName="this member"
				description="The endpoint itself is untouched — it simply stops ringing for this group."
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
