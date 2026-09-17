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
import { routingTabHref } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import {
	usePbxChildDelete,
	usePbxChildReorder,
	usePbxChildren,
	usePbxItem,
} from "../../_hooks/use-pbx-queries";
import { TranslationRuleDialog } from "./translation-rule-dialog";
import { TranslationRulesetDialog } from "./translation-ruleset-dialog";
import type { TranslationRuleRow, TranslationRulesetRow } from "~/lib/pbx/contracts";

/**
 * One ruleset and its pipeline.
 *
 * ## The order is the semantics, more than anywhere else in this app
 *
 * An IVR's options are matched independently and a ring group's members are a delay ladder. A
 * ruleset is neither: every enabled rule fires in turn and each one sees the LAST one's output, so
 * two correct rules in the wrong order produce a number nobody dialled. That is why the reorder is a
 * whole-list write to `PUT …/rules/reorder` rather than a sequence of PATCHes — the unique
 * `(ruleset, ordinal)` index would refuse most of the intermediate states anyway, and each one that
 * was writable would publish another pipeline to the routing cache.
 *
 * There is no optimistic swap, for the reason the paging-group editor gives: the reply carries the
 * collection as the server stored it, and a refused permutation must not leave a rearranged list on
 * screen.
 *
 * ## An empty ruleset is a warning, not an error
 *
 * A ruleset with no enabled rules saves, compiles, attaches to a route, and rewrites nothing. That
 * is legitimate — it is how a pipeline is switched off without detaching it from six routes — and it
 * is also exactly what a half-built one looks like, so the page says which it is rather than leaving
 * an operator to infer it from a number that came out unchanged.
 */
export function TranslationRulesetDetail({ rulesetId }: { rulesetId: string }) {
	const ruleset = usePbxItem(PBX_RESOURCES.translationRulesets, rulesetId);
	const rules = usePbxChildren(PBX_CHILDREN.translationRules, "translation-rulesets", rulesetId);
	const removeRule = usePbxChildDelete(
		PBX_CHILDREN.translationRules,
		"translation-rulesets",
		rulesetId,
	);
	const reorder = usePbxChildReorder(
		PBX_CHILDREN.translationRules,
		"translation-rulesets",
		rulesetId,
	);

	const canWrite = usePermission(PBX_RESOURCES.translationRulesets.permissions.write);
	const canDelete = usePermission(PBX_RESOURCES.translationRulesets.permissions.delete);

	const [rulesetDialogOpen, setRulesetDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<TranslationRuleRow | null>(null);
	const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<TranslationRuleRow | null>(null);

	if (ruleset.isPending) {
		return <LoadingPanel label="Loading ruleset" />;
	}

	if (ruleset.error instanceof ApiError && ruleset.error.status === 404) {
		return (
			<EmptyState
				title="This ruleset no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routingTabHref("translations")} />} variant="secondary">
						Back to translations
					</Button>
				}
			/>
		);
	}

	if (!ruleset.data) {
		return (
			<EmptyState
				title="Could not load this ruleset"
				description={
					ruleset.error instanceof Error ? ruleset.error.message : "Try again in a moment."
				}
			/>
		);
	}

	const row = ruleset.data as TranslationRulesetRow;
	const rows = rules.data ?? [];
	const nextOrdinal = rows.reduce((highest, rule) => Math.max(highest, rule.ordinal + 1), 0);
	const activeRules = rows.filter((rule) => rule.enabled);

	/** Sends the COMPLETE list in its new order — see the note at the top of this file. */
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
		reorder.mutate(next.map((rule) => rule.id));
	}

	return (
		<>
			<PageHeader
				title={row.name}
				description={
					row.description ??
					"An ordered pipeline of rewrites. Attach it to an outbound route or a trunk to use it."
				}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routingTabHref("translations")} />} variant="ghost">
							All rulesets
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setRulesetDialogOpen(true)}>
								Ruleset settings
							</Button>
						) : null}
					</div>
				}
			/>

			{!rules.isPending && activeRules.length === 0 ? (
				<NoticeBanner
					title="Rewrites nothing"
					description={
						rows.length === 0
							? "This ruleset has no rules, so every number attached to it passes through unchanged. That compiles and is legitimate; it is also what a half-built ruleset looks like."
							: "Every rule here is disabled, so every number attached to this ruleset passes through unchanged."
					}
				/>
			) : null}

			{!row.enabled ? (
				<NoticeBanner
					title="Ruleset disabled"
					description="The rules below are not applied on any route or trunk that carries this ruleset, whatever their own state says."
				/>
			) : null}

			<ChildCollectionCard
				title="Rules"
				description="Applied top to bottom. Each rule sees the number the one above it produced, and a rule that does not match is a no-op rather than a failure."
				rows={rows}
				isPending={rules.isPending}
				emptyTitle="No rules yet"
				emptyDescription="Add the first rewrite — a pattern to match, and what to replace the match with."
				addLabel="Add rule"
				onAdd={
					canWrite
						? () => {
								setEditingRule(null);
								setRuleDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "label",
						header: "Step",
						className: "font-medium",
						cell: (rule) => rule.label ?? `Rule ${rule.ordinal}`,
					},
					{
						key: "match",
						header: "Match",
						className: "font-mono text-xs",
						cell: (rule) => rule.matchPattern,
					},
					{
						key: "replacement",
						header: "Replace with",
						className: "font-mono text-xs",
						cell: (rule) =>
							rule.replacement.length > 0 ? (
								rule.replacement
							) : (
								<span className="font-sans text-muted-foreground">nothing (strips the match)</span>
							),
					},
					{ key: "ordinal", header: "Order", cell: (rule) => rule.ordinal },
					{
						key: "enabled",
						header: "State",
						cell: (rule) => <EnabledBadge enabled={rule.enabled} />,
					},
				]}
				rowActions={(rule) => {
					const index = rows.findIndex((entry) => entry.id === rule.id);
					return (
						<RowActions
							label={rule.label ?? `rule ${rule.ordinal}`}
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
											setEditingRule(rule);
											setRuleDialogOpen(true);
										}
									: undefined
							}
							onDelete={
								canDelete
									? () => {
											removeRule.reset();
											setPendingDelete(rule);
										}
									: undefined
							}
						/>
					);
				}}
				footer={
					<p className="text-xs text-muted-foreground">
						Where this ruleset sits relative to a route&rsquo;s own digits: an outbound route
						applies its strip and prepend FIRST — turning what somebody&rsquo;s fingers did into the
						number they meant — and this pipeline second, normalising that number for the wire. On a
						trunk there is nothing to compose with, so an inbound ruleset runs first and alone,
						before the call-block list, the inbound routes or the call record read the
						caller&rsquo;s number.
					</p>
				}
			/>

			<TranslationRulesetDialog
				open={rulesetDialogOpen}
				onOpenChange={setRulesetDialogOpen}
				ruleset={row}
			/>

			<TranslationRuleDialog
				key={editingRule?.id ?? `new-${nextOrdinal}`}
				open={ruleDialogOpen}
				onOpenChange={setRuleDialogOpen}
				rulesetId={rulesetId}
				rule={editingRule}
				nextOrdinal={nextOrdinal}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeRule.reset();
					}
				}}
				entityLabel="rule"
				entityName={pendingDelete?.label ?? "this rule"}
				description="The rewrite stops happening on every route and trunk that carries this ruleset, and the rules after it will see the number this one used to produce."
				pending={removeRule.isPending}
				error={removeRule.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeRule.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
