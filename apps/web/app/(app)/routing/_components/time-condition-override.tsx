"use client";

import { useForm } from "@tanstack/react-form";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FormField, Select } from "~/components/ui/field";
import { TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { TIME_CONDITION_OVERRIDES } from "~/lib/pbx/contracts";
import {
	timeConditionOverrideCodeFormSchema,
	type TimeConditionOverrideCodeFormValues,
} from "~/lib/pbx/schemas";
import { usePermission } from "../../_context/session-context";
import { usePbxUpdate, useTimeConditionOverride } from "../../_hooks/use-pbx-queries";
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
 * ## The star code is edited HERE, and it is the one control on this card with a different grant
 *
 * `override_feature_code` is declared by `createTimeConditionDto`/`updateTimeConditionDto` now
 * (`overrideFeatureCode: shortCode.nullish()`), so it is an ordinary `PATCH /time-conditions/:id`
 * and rides `time-conditions.write` — not the `call-flows.toggle` above it. That split is the
 * feature rather than an inconsistency: choosing which digits a phone dials is dial-plan
 * configuration and is compiled, while PRESSING the code is the five-o'clock act a receptionist
 * performs. So the card renders each half only for whoever holds its grant, and somebody may
 * legitimately see one and not the other.
 *
 * It is on this card rather than in "Condition settings" because this is where the question is
 * asked. A person reading "how do I force this open from a handset" is looking at the override
 * control, and the dialog is not reachable at all with the grant that presses it. `PATCH` leaves an
 * absent key alone, so this form and that dialog cannot clobber each other's column.
 *
 * Nothing here checks the code for a COLLISION with the feature-code catalogue: that is a fact about
 * the whole tenant rather than about this row, and the compiler's diagnostic — raised inside the
 * write transaction — is what says "`*281` already answers to something".
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

				<OverrideFeatureCodeField condition={condition} />

				<p className="text-xs text-muted-foreground">
					An override is stored, compiled into the routing model and survives a restart — so setting
					one republishes the dial plan, exactly as editing a rule does, and clearing it republishes
					again. It is not a timer: nothing puts it back.
				</p>
			</CardBody>
		</Card>
	);
}

/**
 * The star code that cycles the override from a handset.
 *
 * Its own component because it has its own grant, its own mutation and its own form state, and
 * folding all three into the card above would have made the permission check on the select apply to
 * the input too. Somebody holding `call-flows.toggle` and not `time-conditions.write` sees the
 * select and a sentence here; somebody holding the reverse sees the code and not the select.
 *
 * The save button appears only once the value differs from what is stored. A code is a
 * once-a-deployment decision, so a permanently live Save on a card whose main control saves on
 * change would read as though the whole card were unsaved.
 */
function OverrideFeatureCodeField({ condition }: { condition: TimeConditionRow }) {
	const canWrite = usePermission(PBX_RESOURCES.timeConditions.permissions.write);
	const update = usePbxUpdate(PBX_RESOURCES.timeConditions);
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: {
			overrideFeatureCode: condition.overrideFeatureCode ?? "",
		} satisfies TimeConditionOverrideCodeFormValues,
		validators: { onSubmit: timeConditionOverrideCodeFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = timeConditionOverrideCodeFormSchema.parse(value);
			server.clear();
			try {
				// A blank box is `null`, which CLEARS the column. Omitting the key would leave the old code
				// answering on every handset in the building while this form showed nothing.
				await update.mutateAsync({
					id: condition.id,
					values: { overrideFeatureCode: parsed.overrideFeatureCode },
				});
			} catch (error) {
				server.capture(error);
			}
		},
	});

	if (!canWrite) {
		return (
			<p className="text-xs text-muted-foreground">
				{condition.overrideFeatureCode ? (
					<>
						Handsets can cycle this by dialling{" "}
						<span className="font-mono text-foreground">{condition.overrideFeatureCode}</span>,
						which steps through the three states in the order above and wraps around. Changing that
						code needs the grant that edits the condition itself.
					</>
				) : (
					"No star code cycles this condition from a handset. Setting one needs the grant that edits the condition itself."
				)}
			</p>
		);
	}

	return (
		<form
			noValidate
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<form.Field name="overrideFeatureCode">
				{(field) => (
					<>
						<TextField
							field={field}
							label="Star code"
							placeholder="*281"
							description="Dialling this from a handset steps through the three states above in order and wraps around — the same cycle the select performs, without a browser. Leave it blank for no code. It is screened against the feature-code catalogue when the dial plan compiles, so a collision comes back as a diagnostic rather than a silent second owner."
							disabled={update.isPending}
							submitError={server.errors.overrideFeatureCode}
						/>
						{field.state.value.trim() !== (condition.overrideFeatureCode ?? "") ? (
							<div className="flex items-center gap-2">
								<Button type="submit" size="sm" variant="secondary" loading={update.isPending}>
									Save code
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={update.isPending}
									onClick={() => {
										server.clear();
										form.reset();
									}}
								>
									Cancel
								</Button>
							</div>
						) : null}
					</>
				)}
			</form.Field>
		</form>
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
