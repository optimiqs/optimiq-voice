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
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routingTabHref } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxChildDelete, usePbxChildren, usePbxItem } from "../../_hooks/use-pbx-queries";
import { TimeConditionDialog } from "./time-condition-dialog";
import { TimeConditionOverrideCard } from "./time-condition-override";
import { describePredicate, TimeRuleDialog } from "./time-rule-dialog";
import type { TimeConditionRow, TimeConditionRuleRow } from "~/lib/pbx/contracts";

/**
 * One time condition and its rules.
 *
 * A condition with no rules never matches, which means every call gated by it takes the no-match
 * branch — silently, and forever. That is not a compile error (the configuration is sound, it is
 * just always false), so nothing in the API will tell the user. This page does.
 */
export function TimeConditionDetail({ conditionId }: { conditionId: string }) {
	const condition = usePbxItem(PBX_RESOURCES.timeConditions, conditionId);
	const rules = usePbxChildren(PBX_CHILDREN.timeConditionRules, "time-conditions", conditionId);
	const removeRule = usePbxChildDelete(
		PBX_CHILDREN.timeConditionRules,
		"time-conditions",
		conditionId,
	);

	const canWrite = usePermission(PBX_RESOURCES.timeConditions.permissions.write);

	const [conditionDialogOpen, setConditionDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<TimeConditionRuleRow | null>(null);
	const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<TimeConditionRuleRow | null>(null);

	if (condition.isPending) {
		return <LoadingPanel label="Loading time condition" />;
	}

	if (condition.error instanceof ApiError && condition.error.status === 404) {
		return (
			<EmptyState
				title="This time condition no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routingTabHref("time-conditions")} />} variant="secondary">
						Back to time conditions
					</Button>
				}
			/>
		);
	}

	if (!condition.data) {
		return (
			<EmptyState
				title="Could not load this time condition"
				description={
					condition.error instanceof Error ? condition.error.message : "Try again in a moment."
				}
			/>
		);
	}

	const row = condition.data as TimeConditionRow;
	const rows = rules.data ?? [];
	const nextOrdinal = rows.reduce((highest, rule) => Math.max(highest, rule.ordinal + 1), 0);
	const activeRules = rows.filter((rule) => rule.enabled);

	return (
		<>
			<PageHeader
				title={row.name}
				description={`Evaluated in ${row.timezone}. Any enabled rule matching is enough.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routingTabHref("time-conditions")} />} variant="ghost">
							All conditions
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setConditionDialogOpen(true)}>
								Condition settings
							</Button>
						) : null}
					</div>
				}
			/>

			{/*
			 * Above the branches and above the "never matches" warning, and rendered even when nothing
			 * is overridden. Both halves of that are deliberate.
			 *
			 * Above, because an override OUTRANKS everything below it: a condition with no rules still
			 * routes every call somewhere useful while it is forced, and a reader who met the warning
			 * first would be told the condition is broken when somebody has deliberately taken the clock
			 * out of the loop.
			 *
			 * Always, because this card IS the control. Showing it only once an override exists would
			 * leave the one action on this page a receptionist can perform reachable only after somebody
			 * else had already performed it.
			 */}
			<TimeConditionOverrideCard condition={row} />

			{!rules.isPending && activeRules.length === 0 ? (
				<WarningsBanner
					title="Never matches"
					description="With no enabled rule, this condition is always false — every call gated by it takes the “otherwise” branch, at every hour of every day."
					warnings={[
						{
							severity: "warning",
							code: "time-condition-has-no-rules",
							message:
								rows.length === 0
									? "Add a rule describing the hours this condition should cover."
									: "Every rule on this condition is disabled.",
							subject: { kind: "time-condition", id: row.id, name: row.name },
						},
					]}
				/>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Branches</CardTitle>
					<CardDescription>Where a gated call goes on each side of the fork.</CardDescription>
				</CardHeader>
				<CardBody className="grid gap-4 sm:grid-cols-2">
					<Branch
						label="While a rule matches"
						destination={describeDestination(
							readDestination(row as unknown as Record<string, unknown>, ""),
						)}
					/>
					<Branch
						label="Otherwise"
						destination={describeDestination(
							readDestination(row as unknown as Record<string, unknown>, "nomatch"),
						)}
					/>
				</CardBody>
			</Card>

			<ChildCollectionCard
				title="Rules"
				description="Each rule is a set of conditions that must all hold. Any rule matching makes the condition true."
				rows={rows}
				isPending={rules.isPending}
				emptyTitle="No rules yet"
				emptyDescription="Describe the hours this condition should cover — weekdays, a time window, a date range."
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
						header: "Rule",
						className: "font-medium",
						cell: (rule) => rule.label ?? `Rule ${rule.ordinal + 1}`,
					},
					{
						key: "predicate",
						header: "Matches when",
						cell: (rule) => (
							<div className="flex flex-col">
								<span className="text-sm">{describePredicate(rule.predicates[0])}</span>
								{rule.predicates.length > 1 ? (
									<span className="mt-1">
										<Badge tone="neutral">+{rule.predicates.length - 1} more alternatives</Badge>
									</span>
								) : null}
							</div>
						),
					},
					{ key: "ordinal", header: "Order", cell: (rule) => rule.ordinal },
					{
						key: "enabled",
						header: "State",
						cell: (rule) => <EnabledBadge enabled={rule.enabled} />,
					},
				]}
				rowActions={(rule) => (
					<RowActions
						label={rule.label ?? `rule ${rule.ordinal + 1}`}
						onEdit={
							canWrite
								? () => {
										setEditingRule(rule);
										setRuleDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canWrite
								? () => {
										removeRule.reset();
										setPendingDelete(rule);
									}
								: undefined
						}
					/>
				)}
			/>

			<TimeConditionDialog
				open={conditionDialogOpen}
				onOpenChange={setConditionDialogOpen}
				condition={row}
			/>

			<TimeRuleDialog
				key={editingRule?.id ?? `new-${nextOrdinal}`}
				open={ruleDialogOpen}
				onOpenChange={setRuleDialogOpen}
				conditionId={conditionId}
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
				description="The hours it covered will fall to the “otherwise” branch. If it was the only rule, this condition will never match again."
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

function Branch({ label, destination }: { label: string; destination: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				{label}
			</span>
			<span className="text-sm text-foreground">{destination}</span>
		</div>
	);
}
