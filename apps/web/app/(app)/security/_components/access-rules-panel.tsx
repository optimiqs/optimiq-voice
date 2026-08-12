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
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { SIP_ACL_SCOPE_LABELS } from "~/lib/pbx/security-labels";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { SipAclEntryDialog } from "./sip-acl-entry-dialog";
import type { SipAclEntryRow } from "~/lib/pbx/contracts";

/**
 * The CIDR allowlist — the toll-fraud gate.
 *
 * ## The order on screen is the order the rules are evaluated in
 *
 * The server orders this resource by `(priority, id)` — `SIP_ACL_ENTRY_RESOURCE.orderBy` — so the
 * table needs no sort control and must not add one. A list of ordered rules displayed in some other
 * order is a list that will be read as the evaluation order anyway, and the first surprise would be
 * a deny somebody thought came later. The header says "lower wins" for the same reason.
 *
 * A tie is broken by the LONGER PREFIX, which is decided on the server and cannot be shown as a row
 * position; the column description says so rather than the table pretending the sort is complete.
 *
 * ## Every scope is its own list, and they are deliberately not merged
 *
 * The unique index is `(organization_id, scope, network)`, so `203.0.113.0/24` in `registration`
 * and the same network in `trunk` are two rows that do different things. Showing them in one table
 * with a scope column is the honest rendering: grouping by scope would hide that a network appears
 * twice, and a "scope: all" filter default would hide three quarters of the rules from somebody
 * auditing them.
 *
 * ## The delete has no reference check to fail
 *
 * Nothing holds a foreign key to an ACL entry and it carries no destination trio, so a delete can
 * never be refused for a referrer — unlike almost every other list in this app. The confirmation
 * therefore explains the CONSEQUENCE (the addresses stop being matched) rather than warning about
 * dangling rows.
 */
export function AccessRulesPanel() {
	const resource = PBX_RESOURCES.sipAclEntries;
	// Prefixed, because the auth-failure ledger shares this URL and both tabs read query state.
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState("acl");
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<SipAclEntryRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<SipAclEntryRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New access rule
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Rule name or description"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No access rules yet"
				emptyDescription="Without a rule the surfaces below apply their own defaults. Add one to say which networks may register phones, terminate calls through a trunk, fetch provisioning files or reach the API."
				emptyAction={createButton}
				caption="SIP access rules, in the order they are evaluated"
				columns={[
					{
						key: "priority",
						header: "Priority",
						className: "whitespace-nowrap",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.priority}
							</span>
						),
					},
					{
						key: "network",
						header: "Network",
						className: "font-mono whitespace-nowrap",
						cell: (row) => row.network,
					},
					{
						key: "action",
						header: "Action",
						cell: (row) => (
							<Badge tone={row.action === "allow" ? "success" : "danger"}>
								{row.action === "allow" ? "Allow" : "Deny"}
							</Badge>
						),
					},
					{
						key: "scope",
						header: "Scope",
						cell: (row) => (
							<span className="text-sm text-foreground">{SIP_ACL_SCOPE_LABELS[row.scope]}</span>
						),
					},
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => row.name ?? <span className="text-muted-foreground">—</span>,
					},
					{
						key: "description",
						header: "Note",
						cell: (row) =>
							row.description ? (
								<span className="text-sm text-muted-foreground">{row.description}</span>
							) : (
								<span className="text-muted-foreground">—</span>
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
						label={`access rule ${row.network}`}
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

			{/*
			 * The sentence `sip-acl.resource.ts` asks to be said plainly, and the one thing an
			 * administrator will be surprised by. It is a note under the table rather than a banner
			 * because it is true of every row all the time — a banner that never goes away stops being
			 * read after the second visit.
			 */}
			<p className="max-w-prose text-xs text-muted-foreground">
				Rules are evaluated lowest priority first, and a tie is broken by the longer prefix. Saving
				a rule stores it immediately, but{" "}
				<strong className="font-medium text-foreground">
					an edit here does not reach the media server by itself
				</strong>{" "}
				— the SIP access configuration has to be regenerated and the transport reloaded before
				registration and trunk rules take effect. Provisioning and API rules are read from the
				database and apply straight away.
			</p>

			<SipAclEntryDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				entry={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="access rule"
				entityName={pendingDelete ? pendingDelete.network : "this access rule"}
				description="The network stops being matched on this surface, and whatever the surface does without a rule applies instead. Disabling the rule has the same effect and keeps it here to turn back on."
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
