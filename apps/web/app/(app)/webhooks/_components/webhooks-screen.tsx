"use client";

import { useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import {
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
import { selectorLabel } from "~/lib/pbx/webhook-selectors";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { WebhookDialog } from "./webhook-dialog";
import { WebhookSecretDialog } from "./webhook-secret-dialog";
import type { WebhookRow } from "~/lib/pbx/contracts";

/**
 * Outbound webhook subscriptions — the integrator surface.
 *
 * ## The state column is three facts, not one switch
 *
 * A subscription can be on, off because somebody turned it off, or off because the PLATFORM turned
 * it off after consecutive failures. The third is the one worth a distinct badge: an administrator
 * who disabled an endpoint knows why, and one who finds it disabled needs to be told that we did it
 * and when. Rendering `autoDisabledAt` as an ordinary "Disabled" would turn a delivery outage into a
 * mystery.
 *
 * Re-enabling through the dialog clears the failure counter and `auto_disabled_at` together, which
 * is what makes "fix the endpoint, turn it back on" a complete recovery rather than one that
 * re-disables on the next bad delivery. That is the server's behaviour, not this screen's, and the
 * dialog says so where the switch is.
 *
 * ## There is no delivery history here, because there is no endpoint for one
 *
 * The API exposes five verbs on `/api/v1/webhooks` and nothing else — no deliveries collection, no
 * dead-letter queue, no replay. What a tenant can see about delivery is the four read-only columns
 * ON the subscription: the consecutive failure count, the last failure and its one-line reason, and
 * the last success. So those are surfaced properly rather than a "Deliveries" tab being built
 * against a route that does not exist.
 *
 * ## What the table never shows
 *
 * The signing key. `secret` is in `secretColumns`, so the generic redaction strips it from every
 * list, get and update body — a "Secret" column would be `undefined` on every row and would read as
 * "this endpoint has no secret" when every endpoint has one. It crosses the boundary exactly once,
 * in the create response, and {@link WebhookSecretDialog} is the one place that renders it.
 */
export function WebhooksScreen() {
	const resource = PBX_RESOURCES.webhooks;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<WebhookRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<WebhookRow | null>(null);
	/** The generated key, held only long enough for the administrator to copy it. */
	const [issuedSecret, setIssuedSecret] = useState<string | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New webhook
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Webhooks"
				description="Push call, queue, voicemail and call-record events to your own systems. Every delivery is signed, so the receiving end can prove it came from here."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Endpoint URL or description"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No webhooks yet"
				emptyDescription="Point an endpoint at this organization and choose which event families it should receive — a screen-pop, a wallboard, a missed-message alert or a billing export."
				emptyAction={createButton}
				caption="Outbound webhook subscriptions"
				columns={[
					{
						key: "url",
						header: "Endpoint",
						className: "font-mono text-sm break-all",
						cell: (row) => (
							<>
								{row.url}
								{row.description ? (
									<span className="block font-sans text-xs text-muted-foreground">
										{row.description}
									</span>
								) : null}
							</>
						),
					},
					{
						key: "selectors",
						header: "Receives",
						cell: (row) => <SelectorSummary selectors={row.eventSelectors} />,
					},
					{
						key: "delivery",
						header: "Delivery",
						cell: (row) => <DeliverySummary row={row} />,
					},
					{
						key: "state",
						header: "State",
						cell: (row) => <WebhookStateBadge row={row} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`webhook ${row.description ?? row.url}`}
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

			<p className="max-w-prose text-xs text-muted-foreground">
				A subscription filters on WHAT, never on whose: the events it receives are always this
				organization&rsquo;s, decided from the session that owns the subscription rather than from
				anything in the selector. Signing keys are shown once, when the webhook is created, and can
				be replaced but never read back.
			</p>

			<WebhookDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				webhook={editing}
				onSecretIssued={(secret) => setIssuedSecret(secret)}
			/>

			<WebhookSecretDialog secret={issuedSecret} onDismiss={() => setIssuedSecret(null)} />

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="webhook"
				entityName={
					pendingDelete ? (pendingDelete.description ?? pendingDelete.url) : "this webhook"
				}
				description="Deliveries to this endpoint stop immediately and the signing key is gone with it — recreating the subscription mints a new one. Disabling it stops the same deliveries and keeps the key."
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

/**
 * What an endpoint receives, in one cell.
 *
 * Wildcards read as the family they take whole and exact types read as themselves, because those
 * are two different claims: "everything about calls" is a decision about volume, and
 * "channel.answered" is a decision about one event. A cell that printed the raw selectors would
 * make the reader parse `calls.evt.v1.>` on every row.
 */
function SelectorSummary({ selectors }: { selectors: readonly string[] }) {
	if (selectors.length === 0) {
		return <span className="text-sm text-muted-foreground">Nothing</span>;
	}
	const shown = selectors.slice(0, 3);
	const rest = selectors.length - shown.length;

	return (
		<div className="flex flex-wrap items-center gap-1">
			{shown.map((selector) => (
				<Badge key={selector} tone="neutral" className="font-mono text-[0.6875rem]">
					{selectorLabel(selector)}
				</Badge>
			))}
			{rest > 0 ? <span className="text-xs text-muted-foreground">+{rest} more</span> : null}
		</div>
	);
}

/**
 * The four read-only delivery fields, as one sentence.
 *
 * `consecutiveFailures` counts CONSECUTIVE failures and is zeroed by the first success, so a
 * non-zero count means "it is failing now" rather than "it has ever failed" — which is why the
 * count is shown at all rather than a lifetime total nobody could act on.
 */
function DeliverySummary({ row }: { row: WebhookRow }) {
	if (row.consecutiveFailures > 0) {
		return (
			<div className="flex flex-col gap-0.5">
				<span className="text-sm text-danger">{row.consecutiveFailures} failed in a row</span>
				{row.lastFailureReason ? (
					<span className="text-xs text-muted-foreground" title={row.lastFailureReason}>
						{row.lastFailureReason}
					</span>
				) : null}
				{row.lastFailureAt ? (
					<span className="text-xs text-subtle-foreground" data-tabular>
						{new Date(row.lastFailureAt).toLocaleString()}
					</span>
				) : null}
			</div>
		);
	}
	if (row.lastSuccessAt) {
		return (
			<span className="text-sm text-muted-foreground" data-tabular>
				Last delivered {new Date(row.lastSuccessAt).toLocaleString()}
			</span>
		);
	}
	return <span className="text-sm text-muted-foreground">No deliveries yet</span>;
}

/**
 * On, off, or off because we switched it off.
 *
 * The third is deliberately not the same badge as the second: `autoDisabledAt` is separate from
 * `enabled` on the server precisely so this distinction can be made, and collapsing it here would
 * throw away the only notice a tenant gets that the platform stopped delivering on their behalf.
 */
function WebhookStateBadge({ row }: { row: WebhookRow }) {
	if (row.autoDisabledAt !== null) {
		return (
			<div className="flex flex-col gap-0.5">
				<Badge tone="danger">Auto-disabled</Badge>
				<span className="text-xs text-muted-foreground" data-tabular>
					{new Date(row.autoDisabledAt).toLocaleString()}
				</span>
			</div>
		);
	}
	return (
		<Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "Enabled" : "Disabled"}</Badge>
	);
}
