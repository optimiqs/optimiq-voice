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
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { CallBlockRuleDialog } from "./call-block-rule-dialog";
import type {
	CallBlockAction,
	CallBlockDirection,
	CallBlockMatchKind,
	CallBlockRuleRow,
} from "~/lib/pbx/contracts";

/**
 * Caller screening — the allow/deny list.
 *
 * ## The two read-only columns are why this screen is worth having
 *
 * `hitCount` and `lastHitAt` are written by enforcement and refused by both DTOs, so nothing here
 * can send them. They are rendered prominently all the same, because a screening list without them
 * is a list of guesses: "this rule has never matched anything" is the difference between a rule
 * that is protecting somebody and one that was typed wrong six months ago, and no other column can
 * tell those apart.
 *
 * ## Disable and delete are different acts, and the screen says so
 *
 * Switching a rule off leaves the row, its counter and its last-hit date — the evidence that this
 * number was calling — and deleting it destroys that. The API splits `call-block.delete` from
 * `call-block.write` for exactly that reason, so the delete confirmation says what is lost rather
 * than treating the two as the same button with a different colour.
 *
 * ## No destination column, and there will not be one
 *
 * `action: "voicemail"` looks like it should carry one and does not: the compiler sends the caller
 * to the CALLEE's own mailbox rather than to somewhere the rule chose. A rule that could re-point a
 * blocked caller anywhere in the dial plan would be an inbound route wearing a blocklist's name.
 */

/**
 * `allow` is the loud one, deliberately.
 *
 * The obvious palette makes `block` red and everything else grey, on the reading that blocking is
 * the dangerous act. It is the wrong way round: `block` is the rule somebody meant to write, and
 * `allow` is the one that lifts a number OUT of a broad prefix block — the entry that quietly
 * re-admits a caller the organization decided to exclude. So `allow` carries the tone that makes a
 * reader stop on it while scanning a long list.
 */
const ACTION_TONE: Readonly<Record<CallBlockAction, "neutral" | "accent" | "warning">> = {
	block: "neutral",
	allow: "warning",
	reject: "neutral",
	voicemail: "accent",
};

const ACTION_LABELS: Readonly<Record<CallBlockAction, string>> = {
	block: "Block",
	allow: "Allow",
	reject: "Reject",
	voicemail: "To voicemail",
};

const DIRECTION_LABELS: Readonly<Record<CallBlockDirection, string>> = {
	inbound: "Caller",
	outbound: "Dialled",
	both: "Either way",
};

const MATCH_KIND_LABELS: Readonly<Record<CallBlockMatchKind, string>> = {
	exact: "exact match",
	prefix: "prefix",
	regex: "regular expression",
};

export function CallBlockScreen() {
	const resource = PBX_RESOURCES.callBlockRules;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<CallBlockRuleRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<CallBlockRuleRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New rule
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				title="Call blocking"
				description="Numbers this organization refuses, and the ones it lets through anyway. Rules are checked on every call — an inbound DID, an internal dial and an outbound dial alike — and an emergency number is never screened."
				actions={createButton}
			/>

			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Number, pattern or note"
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="Nothing is screened yet"
				emptyDescription="A rule matches a number and decides what happens to the call. Start with the number that keeps ringing: an exact match set to Block is the whole of most screening lists."
				emptyAction={createButton}
				caption="Caller screening rules in this organization"
				columns={[
					{
						key: "pattern",
						header: "Number",
						className: "font-medium",
						cell: (row) => (
							<div className="flex flex-col">
								<span className="font-mono text-xs">{row.pattern}</span>
								<span className="text-xs text-muted-foreground">
									{MATCH_KIND_LABELS[row.matchKind]}
									{row.label ? ` · ${row.label}` : ""}
								</span>
							</div>
						),
					},
					{
						key: "direction",
						header: "Matched against",
						cell: (row) => (
							<span className="text-sm text-muted-foreground">
								{DIRECTION_LABELS[row.direction]}
							</span>
						),
					},
					{
						key: "action",
						header: "Then",
						cell: (row) => (
							<Badge tone={ACTION_TONE[row.action]}>{ACTION_LABELS[row.action]}</Badge>
						),
					},
					{
						/**
						 * The evidence column. A rule that has never fired renders as "Never" rather than
						 * as an empty cell — "no data" and "this has caught nothing" look identical when
						 * one of them is a blank, and only one of them is worth acting on.
						 */
						key: "hits",
						header: "Matched",
						cell: (row) =>
							row.hitCount === 0 ? (
								<span className="text-sm text-muted-foreground">Never</span>
							) : (
								<div className="flex flex-col">
									<span className="text-sm" data-tabular>
										{row.hitCount === 1 ? "Once" : `${row.hitCount} calls`}
									</span>
									{row.lastHitAt === null ? null : (
										<span className="text-xs text-muted-foreground whitespace-nowrap">
											last {new Date(row.lastHitAt).toLocaleString()}
										</span>
									)}
								</div>
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
						label={`screening rule ${row.pattern}`}
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

			<CallBlockRuleDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				rule={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="screening rule"
				entityName={pendingDelete ? pendingDelete.pattern : "this rule"}
				description="The rule and its match history go with it — how many calls it caught, and when it last did. If you only want it to stop applying, switch it off instead: a disabled rule keeps that record and can be turned back on."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>

			<p className="max-w-prose text-xs text-muted-foreground">
				Screening runs before routing on every call, and an allow rule wins over a block rule that
				matches just as specifically — which is how one number escapes a whole blocked prefix.
				Emergency numbers bypass this list entirely and cannot be screened.
			</p>
		</>
	);
}
