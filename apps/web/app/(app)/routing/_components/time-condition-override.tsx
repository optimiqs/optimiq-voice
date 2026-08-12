"use client";

import { Badge } from "~/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FormField, Select } from "~/components/ui/field";
import { TIME_CONDITION_OVERRIDES } from "~/lib/pbx/contracts";
import { usePermission } from "../../_context/session-context";
import { useTimeConditionOverride } from "../../_hooks/use-pbx-queries";
import type { TimeConditionOverride, TimeConditionRow } from "~/lib/pbx/contracts";

/**
 * The manual override — "we are closed early today", expressed as a column.
 *
 * ## Why the names are not "open" and "closed"
 *
 * `forced-match` and `forced-no-match` say what they DO rather than what they mean, and the server
 * is explicit that this is deliberate: plenty of conditions match on "out of hours" and route the
 * match branch to voicemail, so `forced-open` / `forced-closed` would be a guess about somebody
 * else's configuration. This control resists the same temptation and names the BRANCH each state
 * takes, which the page has already shown two cards above.
 *
 * ## Why it is here rather than in the condition's own dialog
 *
 * The override is guarded by `call-flows.toggle`, not by `time-conditions.write` — forcing a
 * condition open and flipping a call flow to night are one act on two tables, and the permission
 * registry collapses them for exactly that reason. So the control has to be reachable by somebody
 * who cannot open "Condition settings" at all, which a field inside that dialog could not be. The
 * endpoint agrees: it is `POST /call-flows/time-conditions/:id/override`, and `PATCH
 * /time-conditions/:id` does not accept the column.
 *
 * ## The star code is shown and not edited
 *
 * `override_feature_code` is a real column the compiler screens against the feature-code catalogue,
 * and NO endpoint accepts it in either direction today — `createTimeConditionDto` does not declare
 * it, and it is a `z.strictObject`. So it is rendered as a fact when a tenant has one and the card
 * says where it comes from, rather than offering a control whose save would be a 400.
 */
const OVERRIDE_LABELS: Readonly<Record<TimeConditionOverride, string>> = {
	auto: "Follow the schedule",
	"forced-match": "Force the matching branch",
	"forced-no-match": "Force the “otherwise” branch",
};

const OVERRIDE_DESCRIPTIONS: Readonly<Record<TimeConditionOverride, string>> = {
	auto: "The rules below decide, hour by hour. This is where a condition sits until somebody overrules it.",
	"forced-match":
		"Every gated call takes the matching branch whatever the clock says, until this is set back.",
	"forced-no-match":
		"Every gated call takes the “otherwise” branch whatever the clock says, until this is set back.",
};

export function TimeConditionOverrideCard({ condition }: { condition: TimeConditionRow }) {
	const canToggle = usePermission("call-flows.toggle");
	const override = useTimeConditionOverride();

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="flex min-w-0 flex-col gap-1">
						<CardTitle>Override</CardTitle>
						<CardDescription>
							Overrule the schedule without editing a rule — the office closing early, a holiday
							nobody put in the calendar.
						</CardDescription>
					</div>
					<OverrideBadge value={condition.override} />
				</div>
			</CardHeader>
			<CardBody className="flex flex-col gap-4">
				{canToggle ? (
					<FormField
						name="timeConditionOverride"
						label="Right now"
						description={OVERRIDE_DESCRIPTIONS[condition.override]}
					>
						<Select
							id="timeConditionOverride"
							value={condition.override}
							disabled={override.isPending}
							onChange={(event) =>
								override.mutate({
									id: condition.id,
									override: event.target.value as TimeConditionOverride,
								})
							}
						>
							{TIME_CONDITION_OVERRIDES.map((value) => (
								<option key={value} value={value}>
									{OVERRIDE_LABELS[value]}
								</option>
							))}
						</Select>
					</FormField>
				) : (
					<p className="text-sm text-muted-foreground">
						{OVERRIDE_DESCRIPTIONS[condition.override]} Changing it needs the grant that also moves
						a call flow between day and night.
					</p>
				)}

				<p className="text-xs text-muted-foreground">
					An override is stored, compiled into the routing model and survives a restart — so setting
					one republishes the dial plan, exactly as editing a rule does, and clearing it republishes
					again. It is not a timer: nothing puts it back.
					{condition.overrideFeatureCode ? (
						<>
							{" "}
							Handsets can cycle it by dialling{" "}
							<span className="font-mono text-foreground">{condition.overrideFeatureCode}</span>,
							which steps through the three states in the order above and wraps around. That code is
							set outside this app today.
						</>
					) : null}
				</p>
			</CardBody>
		</Card>
	);
}

/**
 * The current state, as a pill.
 *
 * Both forced states are `warning` and neither is `danger`, which is a deliberate flattening: the
 * dangerous one depends on the tenant's wiring — an office forced OPEN over a holiday is worse than
 * one forced closed, and a condition whose match branch is voicemail inverts that. Amber for "a
 * human has taken the clock out of the loop" is the one thing that is true either way, and it is the
 * same claim the busy-lamp makes (`lit` when the override is anything but `auto`).
 */
export function OverrideBadge({ value }: { value: TimeConditionOverride }) {
	if (value === "auto") {
		return <Badge tone="neutral">On schedule</Badge>;
	}
	return (
		<Badge tone="warning">
			{value === "forced-match" ? "Forced: matching" : "Forced: otherwise"}
		</Badge>
	);
}
