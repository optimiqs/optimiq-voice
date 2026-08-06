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
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { FeatureCodeDialog } from "./feature-code-dialog";
import { InboundRouteDialog } from "./inbound-route-dialog";
import { OutboundRouteDialog } from "./outbound-route-dialog";
import { TimeConditionDialog } from "./time-condition-dialog";
import type {
	FeatureCodeRow,
	InboundRouteRow,
	OutboundRouteRow,
	TimeConditionRow,
} from "~/lib/pbx/contracts";

/**
 * The four list panels behind the Routing tabs.
 *
 * Each keeps its own URL state under a distinct prefix (`in`, `out`, `tc`, `fc`), so switching
 * tabs does not reset the search on the tab you came from and a link to a filtered view survives
 * a reload. One shared prefix would make searching inbound routes silently page the outbound
 * table too.
 */

export function InboundRoutesPanel() {
	const resource = PBX_RESOURCES.inboundRoutes;
	const state = useListQueryState("in");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<InboundRouteRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<InboundRouteRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New inbound route
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or pattern"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No inbound routes yet"
				emptyDescription="An inbound route claims arriving calls and sends them somewhere. Without one, every call falls back to its number's default destination."
				emptyAction={createButton}
				caption="Inbound routes"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "match",
						header: "Claims",
						cell: (row) => (
							<div className="flex flex-col">
								<span className="text-sm">
									{row.matchKind === "any" ? "Any call" : (row.matchPattern ?? "—")}
								</span>
								<span className="text-xs text-muted-foreground">
									{row.matchKind}
									{row.phoneNumberId ? " · one number only" : ""}
									{row.callerIdPattern ? ` · caller ${row.callerIdPattern}` : ""}
								</span>
							</div>
						),
					},
					{
						key: "destination",
						header: "Sends to",
						cell: (row) =>
							describeDestination(readDestination(row as unknown as Record<string, unknown>, "")),
					},
					{
						key: "priority",
						header: "Priority",
						cell: (row) => <span data-tabular>{row.priority}</span>,
					},
					{
						key: "gate",
						header: "Gated",
						cell: (row) => (row.timeConditionId ? <Badge tone="accent">Timed</Badge> : "—"),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`inbound route ${row.name}`}
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
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<InboundRouteDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				route={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="route"
				entityName={pendingDelete ? pendingDelete.name : "this route"}
				description="Calls this route used to claim will fall through to the next matching route, or to the number's own default destination."
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

export function OutboundRoutesPanel() {
	const resource = PBX_RESOURCES.outboundRoutes;
	const state = useListQueryState("out");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<OutboundRouteRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<OutboundRouteRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New outbound route
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Route name"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No outbound routes yet"
				emptyDescription="An outbound route claims a dialled number, rewrites the digits and hands the call to a carrier. Without one, no call can leave."
				emptyAction={createButton}
				caption="Outbound routes"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "patterns",
						header: "Claims",
						cell: (row) => (
							<div className="flex flex-col">
								<span className="font-mono text-xs">
									{row.dialPatterns.slice(0, 2).join(", ")}
									{row.dialPatterns.length > 2 ? ` +${row.dialPatterns.length - 2} more` : ""}
								</span>
								<span className="text-xs text-muted-foreground">
									{row.stripDigits > 0 ? `strip ${row.stripDigits}` : "no strip"}
									{row.prependDigits ? ` · prepend ${row.prependDigits}` : ""}
								</span>
							</div>
						),
					},
					{
						key: "tollClass",
						header: "Costs",
						cell: (row) => <Badge tone="warning">{row.tollClass}</Badge>,
					},
					{
						key: "trunks",
						header: "Carriers",
						cell: (row) =>
							row.trunkPriority.length === 0 ? (
								<Badge tone="danger">None</Badge>
							) : (
								`${row.trunkPriority.length} in order`
							),
					},
					{
						key: "priority",
						header: "Priority",
						cell: (row) => <span data-tabular>{row.priority}</span>,
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`outbound route ${row.name}`}
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
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<OutboundRouteDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				route={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="route"
				entityName={pendingDelete ? pendingDelete.name : "this route"}
				description="Numbers this route used to claim will fall to the next matching route. If none matches, those calls can no longer be dialled at all."
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

export function TimeConditionsPanel() {
	const resource = PBX_RESOURCES.timeConditions;
	const state = useListQueryState("tc");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<TimeConditionRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<TimeConditionRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New time condition
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or timezone"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No time conditions yet"
				emptyDescription="A time condition is a fork: one destination during the hours you define, another the rest of the time."
				emptyAction={createButton}
				caption="Time conditions"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.timeCondition(row.id)}
								className="text-primary underline-offset-4 hover:underline"
							>
								{row.name}
							</Link>
						),
					},
					{ key: "timezone", header: "Timezone", cell: (row) => row.timezone },
					{
						key: "match",
						header: "While matching",
						cell: (row) =>
							describeDestination(readDestination(row as unknown as Record<string, unknown>, "")),
					},
					{
						key: "nomatch",
						header: "Otherwise",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "nomatch"),
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
						label={`time condition ${row.name}`}
						detailHref={routes.timeCondition(row.id)}
						detailLabel="Open rules"
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
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<TimeConditionDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				condition={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="condition"
				entityName={pendingDelete ? pendingDelete.name : "this condition"}
				description="Its rules are removed with it. Routes gated by this condition, and anything pointing at it as a destination, must be changed first — the delete is refused while either is true."
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

export function FeatureCodesPanel() {
	const resource = PBX_RESOURCES.featureCodes;
	const state = useListQueryState("fc");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<FeatureCodeRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<FeatureCodeRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New feature code
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Code or label"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No feature codes yet"
				emptyDescription="Star codes let staff reach a feature from a handset — *97 for voicemail, *69 to redial."
				emptyAction={createButton}
				caption="Feature codes"
				columns={[
					{
						key: "code",
						header: "Dial",
						className: "font-mono font-medium whitespace-nowrap",
						cell: (row) => row.code,
					},
					{ key: "action", header: "Does", cell: (row) => row.action },
					{ key: "label", header: "Label", cell: (row) => row.label ?? "—" },
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`feature code ${row.code}`}
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
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<FeatureCodeDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				code={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="code"
				entityName={pendingDelete ? pendingDelete.code : "this code"}
				description="Staff dialling it will get whatever normal routing does with those digits, which is usually nothing."
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
