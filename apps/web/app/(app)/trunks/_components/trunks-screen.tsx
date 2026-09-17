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
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { useLiveTrunks } from "../../_hooks/use-live-queries";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { TrunkDialog } from "./trunk-dialog";
import type { LiveTrunkStatus } from "~/lib/live/store";
import type { TrunkRow, TrunkStatus } from "~/lib/pbx/contracts";

/**
 * Trunks: how calls leave and arrive.
 *
 * `status` is shown but never editable — it is what the engine observed, and an admin who could
 * set it could declare a dead carrier healthy. `updateTrunkDto` refuses the four `status*` columns
 * for exactly that reason, so there is no form that could send one. A trunk referenced by an
 * outbound route cannot be deleted; the reference lives inside `outbound_route.trunk_priority`
 * (JSONB), which no foreign key can express, so the API scans for it explicitly and answers 409.
 *
 * ## The status column is live, and the live answer wins
 *
 * The SIP edge pings every carrier on a timer, the engine publishes a transition when the answer
 * changes, and two things happen with it: a durable consumer on the API writes the `trunk.status*`
 * columns, and the `trunks` live topic carries the same event to whoever is looking. This screen
 * reads both — the columns for what is true on load, the socket for what has moved since — and
 * prefers the socket, because the two paths race and the frame is the earlier of them.
 *
 * That is why the cell reads `live.get(row.id) ?? row`: not because the row is unreliable, but
 * because a page open during an outage should light up when the outage starts rather than when
 * somebody presses reload. On a reload the columns are the answer and the overlay is empty again,
 * which is the correct state rather than a loss.
 *
 * A session without `trunks.read` never subscribes — the same grant guards the list, so a topic
 * this page could not fill is one it does not ask for.
 */
const STATUS_TONE: Readonly<Record<TrunkStatus, "success" | "danger" | "warning" | "neutral">> = {
	up: "success",
	down: "danger",
	degraded: "warning",
	disabled: "neutral",
	unknown: "neutral",
};

/**
 * The words, rather than the column's values.
 *
 * `unknown` is the one that has to be worded rather than printed: it means the pinger has not
 * reported, which reads to an administrator as a bug in this screen unless it says so. The other
 * four are self-explanatory and are only capitalised.
 */
const STATUS_LABELS: Readonly<Record<TrunkStatus, string>> = {
	up: "Up",
	down: "Down",
	degraded: "Degraded",
	disabled: "Disabled",
	unknown: "Not yet checked",
};

function isTrunkStatus(value: string): value is TrunkStatus {
	return value in STATUS_TONE;
}

/**
 * One trunk's reachability, from whichever source is later.
 *
 * ## The two sources are taken WHOLE, never merged field by field
 *
 * The tempting version is `live?.reason ?? row.statusReason`, and it is wrong in a way that only
 * shows up on the transition that matters. `reason` and `latencyMs` are optional on the event —
 * the media server does not always say why, and does not always measure — so a `down → up` frame
 * carrying no reason would fall back to the row's `Unreachable` from the previous transition and
 * render "Up · Unreachable". Each source describes ONE moment, so the cell reads one of them
 * entirely: the frame if there is one, the columns otherwise.
 *
 * A frame this build cannot make sense of never reaches here — `parseTrunkStatusEvent` drops it, so
 * the row's own answer survives rather than being half-overwritten. `isTrunkStatus` is the second
 * line for the same reason: the parser's vocabulary and this component's badge palette are two
 * lists, and a status in the first but not the second would be an unstyled badge.
 */
function TrunkStatusCell({ row, live }: { row: TrunkRow; live: LiveTrunkStatus | undefined }) {
	const observed =
		live !== undefined && isTrunkStatus(live.status)
			? {
					status: live.status,
					changedAt: live.at,
					reason: live.reason ?? null,
					latencyMs: live.latencyMs ?? null,
				}
			: {
					status: row.status,
					changedAt: row.statusChangedAt,
					reason: row.statusReason,
					latencyMs: row.statusLatencyMs,
				};

	return (
		<div className="flex flex-col gap-0.5">
			<span>
				<Badge tone={STATUS_TONE[observed.status]}>{STATUS_LABELS[observed.status]}</Badge>
			</span>
			{observed.changedAt === null ? null : (
				<span className="text-xs whitespace-nowrap text-muted-foreground">
					since {new Date(observed.changedAt).toLocaleString()}
				</span>
			)}
			{observed.reason === null ? null : (
				<span className="text-xs text-muted-foreground">
					{observed.reason}
					{observed.latencyMs === null ? "" : ` · ${observed.latencyMs} ms`}
				</span>
			)}
		</div>
	);
}

export function TrunksScreen() {
	const resource = PBX_RESOURCES.trunks;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);
	const liveTrunks = useLiveTrunks();

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<TrunkRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<TrunkRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New trunk
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Trunks"
				description="The carrier connections calls travel over. Status is what the SIP edge last observed — it updates here as carriers move, and it cannot be set by hand."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name, domain or proxy"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No trunks yet"
				emptyDescription="A trunk is a carrier connection. Outbound routes choose between them in priority order; without one, no call can leave."
				emptyAction={createButton}
				caption="SIP trunks in this organization"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "proxy",
						header: "Where it connects",
						cell: (row) => (
							<div className="flex flex-col">
								<span className="font-mono text-xs">{row.sipProxy}</span>
								<span className="text-xs text-muted-foreground">
									{row.sipDomain} · {row.transport.toUpperCase()} · {row.kind}
								</span>
							</div>
						),
					},
					{
						key: "capacity",
						header: "Capacity",
						cell: (row) => (row.maxChannels === null ? "No limit" : `${row.maxChannels} calls`),
					},
					{
						key: "status",
						header: "Carrier status",
						cell: (row) => <TrunkStatusCell row={row} live={liveTrunks.statuses.get(row.id)} />,
					},
					{
						key: "provider",
						header: "Provider",
						cell: (row) =>
							row.carrierProvider === null ? (
								<Badge tone="neutral">BYO SIP</Badge>
							) : (
								<Badge tone="accent">{row.carrierProvider}</Badge>
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
						label={`trunk ${row.name}`}
						detailHref={routes.trunk(row.id)}
						detailLabel="Open"
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

			<TrunkDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				trunk={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="trunk"
				entityName={pendingDelete ? pendingDelete.name : "this trunk"}
				description="Calls stop using this carrier immediately. Any outbound route that lists this trunk must drop it first — the delete is refused while a route still names it, so no route is left with nowhere to send a call."
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
