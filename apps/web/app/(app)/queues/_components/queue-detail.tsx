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
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { queueTabHref, routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import {
	usePbxChildDelete,
	usePbxChildren,
	usePbxItem,
	usePbxList,
} from "../../_hooks/use-pbx-queries";
import { QueueDialog } from "./queue-dialog";
import { AgentStatusBadge } from "./queue-shared";
import { QueueTierDialog } from "./queue-tier-dialog";
import type { QueueAgentRow, QueueRow, QueueTierRow } from "~/lib/pbx/contracts";

/**
 * One queue and the agents staffing it.
 *
 * ## Two permissions on one page
 *
 * "Queue settings" is `queues.write`; everything on the memberships panel is
 * `queues.manage-agents`. The API separates them on purpose — a supervisor who staffs the floor is
 * not necessarily the person who may re-point the overflow at an external number — so this page
 * resolves them separately and shows each caller only the buttons their grant covers. Gating the
 * whole page on one of them would hand a supervisor either too much or nothing.
 *
 * ## No drag handle
 *
 * The memberships table is ordered by `(level, position)` and has no reorder control, because the
 * API has no reorder endpoint for tiers and that is a decision rather than a gap: a tier's place is
 * routing policy the caller states, not a list the user rearranges. Sorting is done here, on the
 * same keys the server orders by.
 */
export function QueueDetail({ queueId }: { queueId: string }) {
	const queue = usePbxItem(PBX_RESOURCES.queues, queueId);
	const tiers = usePbxChildren(PBX_CHILDREN.queueTiers, "queues", queueId);
	const removeTier = usePbxChildDelete(PBX_CHILDREN.queueTiers, "queues", queueId);

	/** Tiers carry an agent id; the table has to say a name. Capped at the API's own page size. */
	const agents = usePbxList(PBX_RESOURCES.queueAgents, { page: 1, limit: 100 });
	const agentsById = new Map(agents.rows.map((row: QueueAgentRow) => [row.id, row]));

	const canWrite = usePermission(PBX_RESOURCES.queues.permissions.write);
	const canManageAgents = usePermission(PBX_RESOURCES.queueAgents.permissions.write);

	const [queueDialogOpen, setQueueDialogOpen] = useState(false);
	const [editingTier, setEditingTier] = useState<QueueTierRow | null>(null);
	const [tierDialogOpen, setTierDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<QueueTierRow | null>(null);

	if (queue.isPending) {
		return <LoadingPanel label="Loading queue" />;
	}

	if (queue.error instanceof ApiError && queue.error.status === 404) {
		return (
			<EmptyState
				title="This queue no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.queues} />} variant="secondary">
						Back to queues
					</Button>
				}
			/>
		);
	}

	if (!queue.data) {
		return (
			<EmptyState
				title="Could not load this queue"
				description={queue.error instanceof Error ? queue.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = queue.data as QueueRow;
	const rows = [...(tiers.data ?? [])].sort(
		(a, b) => a.level - b.level || a.position - b.position || a.id.localeCompare(b.id),
	);
	const staffed = rows.filter((tier) => agentsById.get(tier.queueAgentId)?.enabled ?? true);
	const nextPosition = rows
		.filter((tier) => tier.level === 1)
		.reduce((highest, tier) => Math.max(highest, tier.position + 1), 1);

	return (
		<>
			<PageHeader
				title={row.name}
				description={`Offers calls ${row.strategy}, ${
					row.maxWaitSeconds === 0
						? "holds callers indefinitely"
						: `holds callers up to ${row.maxWaitSeconds} seconds`
				}, then goes to ${describeDestination(
					readDestination(row as unknown as Record<string, unknown>, "timeout"),
				).toLowerCase()}.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.queues} />} variant="ghost">
							All queues
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setQueueDialogOpen(true)}>
								Queue settings
							</Button>
						) : null}
					</div>
				}
			/>

			{!tiers.isPending && staffed.length === 0 ? (
				<NoticeBanner
					title="Nobody is staffed"
					description={
						rows.length === 0
							? `No agent serves this queue, so a caller reaching it waits ${
									row.maxWaitNoAgentSeconds === 0
										? "out the full wait"
										: `${row.maxWaitNoAgentSeconds} seconds`
								} and then takes the timeout destination. Add an agent, or point whatever routes calls here somewhere else.`
							: "Every agent serving this queue is disabled, so it can offer a call to nobody."
					}
				/>
			) : null}

			<ChildCollectionCard
				title="Agents"
				description="Who this queue offers calls to. Lower levels are tried first, and every agent at a level is tried before the next one — so this order is routing policy, not a preference."
				rows={rows}
				isPending={tiers.isPending || agents.query.isPending}
				emptyTitle="Nobody serves this queue"
				emptyDescription="Add the agents this queue should offer calls to. An agent can serve several queues at different levels."
				addLabel="Add agent"
				onAdd={
					canManageAgents
						? () => {
								setEditingTier(null);
								setTierDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "agent",
						header: "Agent",
						className: "font-medium",
						cell: (tier) =>
							agentsById.get(tier.queueAgentId)?.name ?? `${tier.queueAgentId.slice(0, 8)}…`,
					},
					{
						key: "level",
						header: "Level",
						cell: (tier) => (
							<span className="text-sm" data-tabular>
								{tier.level}
							</span>
						),
					},
					{
						key: "position",
						header: "Position",
						cell: (tier) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{tier.position}
							</span>
						),
					},
					{
						key: "reached",
						header: "Reached on",
						cell: (tier) => {
							const agent = agentsById.get(tier.queueAgentId);
							if (!agent) {
								return "—";
							}
							return agent.contactKind === "extension" ? (
								<Badge tone="neutral">extension</Badge>
							) : (
								(agent.contact ?? <Badge tone="accent">external</Badge>)
							);
						},
					},
					{
						key: "status",
						header: "Status",
						cell: (tier) => {
							const agent = agentsById.get(tier.queueAgentId);
							return agent ? <AgentStatusBadge status={agent.status} /> : "—";
						},
					},
					{
						key: "enabled",
						header: "State",
						cell: (tier) => {
							const agent = agentsById.get(tier.queueAgentId);
							return agent ? <EnabledBadge enabled={agent.enabled} /> : "—";
						},
					},
				]}
				rowActions={(tier) => (
					<RowActions
						label={`membership for ${agentsById.get(tier.queueAgentId)?.name ?? "this agent"}`}
						onEdit={
							canManageAgents
								? () => {
										setEditingTier(tier);
										setTierDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canManageAgents
								? () => {
										removeTier.reset();
										setPendingDelete(tier);
									}
								: undefined
						}
					/>
				)}
				footer={
					<p className="text-xs text-muted-foreground">
						An agent is an organization-level person, not a member of this queue.{" "}
						<Link
							href={queueTabHref("agents")}
							className="text-primary underline-offset-4 hover:underline"
						>
							Manage agents
						</Link>{" "}
						to change how one is reached or how hard the queue tries them.
					</p>
				}
			/>

			<QueueDialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen} queue={row} />

			<QueueTierDialog
				key={editingTier?.id ?? `new-${nextPosition}`}
				open={tierDialogOpen}
				onOpenChange={setTierDialogOpen}
				tier={editingTier}
				fixedQueueId={queueId}
				suggestedPosition={nextPosition}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeTier.reset();
					}
				}}
				entityLabel="membership"
				entityName={
					pendingDelete
						? `${agentsById.get(pendingDelete.queueAgentId)?.name ?? "this agent"} from ${row.name}`
						: "this membership"
				}
				description="The agent stays, and keeps serving every other queue they are in. They simply stop being offered calls from this one."
				pending={removeTier.isPending}
				error={removeTier.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeTier.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
