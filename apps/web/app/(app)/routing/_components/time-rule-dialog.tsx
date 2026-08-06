"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { cn } from "~/lib/cn";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { timeRuleFormSchema } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { TimeConditionRuleRow, TimeRulePredicate } from "~/lib/pbx/contracts";

/**
 * One rule on a time condition.
 *
 * ## One predicate, not a builder
 *
 * The API models a rule as an ARRAY of predicates ORed together, each an AND of weekday /
 * month-day / month / week-of-month / time-of-day / date-range constraints. That is the full
 * expressive power, and a UI for it is a query builder — which is the wrong tool for "we are open
 * 9 to 5, Monday to Friday". So this form edits ONE predicate: weekdays, a time window, a date
 * range. Two schedules means two rules, which reads better anyway.
 *
 * A rule that already carries several predicates is not destroyed by that decision — it is shown
 * read-only with a note, because silently rewriting someone's holiday schedule into its first
 * clause would be worse than not editing it.
 *
 * ## Crossing midnight
 *
 * `from > to` is legal and means the window wraps: 22:00–06:00 is the night shift. The API is
 * explicit about it, so the form says so rather than validating it away.
 */
const WEEKDAYS: readonly { value: number; label: string; short: string }[] = [
	{ value: 1, label: "Monday", short: "Mon" },
	{ value: 2, label: "Tuesday", short: "Tue" },
	{ value: 3, label: "Wednesday", short: "Wed" },
	{ value: 4, label: "Thursday", short: "Thu" },
	{ value: 5, label: "Friday", short: "Fri" },
	{ value: 6, label: "Saturday", short: "Sat" },
	{ value: 7, label: "Sunday", short: "Sun" },
];

interface RuleFormState {
	label: string;
	ordinal: string;
	fromTime: string;
	toTime: string;
	fromDate: string;
	toDate: string;
	enabled: boolean;
}

function firstPredicate(rule: TimeConditionRuleRow | null): TimeRulePredicate | undefined {
	return rule?.predicates[0];
}

function defaultsFor(rule: TimeConditionRuleRow | null, nextOrdinal: number): RuleFormState {
	const predicate = firstPredicate(rule);
	return {
		label: rule?.label ?? "",
		ordinal: rule === null ? String(nextOrdinal) : String(rule.ordinal),
		fromTime: predicate?.timeOfDay?.from ?? "",
		toTime: predicate?.timeOfDay?.to ?? "",
		fromDate: predicate?.dateRange?.from ?? "",
		toDate: predicate?.dateRange?.to ?? "",
		enabled: rule?.enabled ?? true,
	};
}

export function TimeRuleDialog({
	open,
	onOpenChange,
	conditionId,
	rule,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	conditionId: string;
	rule: TimeConditionRuleRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.timeConditionRules;
	const create = usePbxChildCreate(child, "time-conditions", conditionId);
	const update = usePbxChildUpdate(child, "time-conditions", conditionId);
	const mutation = rule === null ? create : update;
	const server = useServerFieldErrors();

	const initialWeekdays = [...(firstPredicate(rule)?.weekdays ?? [])];
	const [weekdays, setWeekdays] = useState<readonly number[]>(initialWeekdays);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const multiPredicate = (rule?.predicates.length ?? 0) > 1;

	const form = useForm({
		defaultValues: defaultsFor(rule, nextOrdinal),
		onSubmit: async ({ value }) => {
			server.clear();

			const parsed = timeRuleFormSchema.safeParse({
				label: value.label,
				ordinal: value.ordinal,
				weekdays: [...weekdays],
				fromTime: value.fromTime,
				toTime: value.toTime,
				fromDate: value.fromDate,
				toDate: value.toDate,
				enabled: value.enabled,
			});

			if (!parsed.success) {
				const problems: Record<string, string> = {};
				for (const issue of parsed.error.issues) {
					const key = String(issue.path[0] ?? "");
					problems[key] ??= issue.message;
				}
				setLocalErrors(problems);
				return;
			}
			setLocalErrors({});

			/**
			 * A `strictObject` on the server, so a key is present only when it carries something. An
			 * empty `weekdays: []` would read as "matches on no day", which is the opposite of the
			 * "any day" the blank control means.
			 */
			const predicate: Record<string, unknown> = {};
			if (parsed.data.weekdays.length > 0) {
				predicate.weekdays = parsed.data.weekdays;
			}
			if (parsed.data.fromTime !== "" && parsed.data.toTime !== "") {
				predicate.timeOfDay = { from: parsed.data.fromTime, to: parsed.data.toTime };
			}
			if (parsed.data.fromDate !== "" && parsed.data.toDate !== "") {
				predicate.dateRange = { from: parsed.data.fromDate, to: parsed.data.toDate };
			}

			const body = {
				ordinal: parsed.data.ordinal ?? 0,
				label: parsed.data.label,
				predicates: [predicate],
				enabled: parsed.data.enabled,
			};

			try {
				if (rule === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: rule.id, values: body });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	const errors = { ...server.errors, ...localErrors };

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					server.clear();
					mutation.reset();
					setLocalErrors({});
					setWeekdays(initialWeekdays);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={rule === null ? "Add rule" : "Edit rule"}
			description="When this condition matches. Everything you fill in must be true at once; leave a field blank to ignore it."
			submitLabel={rule === null ? "Add rule" : "Save rule"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote={
				multiPredicate
					? "This rule was built with several alternatives. Saving here replaces them with the single set of conditions above."
					: "Need a second schedule — say, Saturday mornings? Add a second rule. Any rule matching is enough."
			}
		>
			<FormSection title="Rule">
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Weekday office hours"
							autoFocus={rule === null}
							disabled={mutation.isPending}
							submitError={errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Order"
							placeholder="0"
							disabled={mutation.isPending}
							submitError={errors.ordinal}
						/>
					)}
				</form.Field>
			</FormSection>

			<fieldset disabled={mutation.isPending}>
				<legend className="text-sm font-medium text-foreground">On these days</legend>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Select none to match any day of the week.
				</p>
				<div className="mt-2 flex flex-wrap gap-1.5">
					{WEEKDAYS.map((day) => {
						const selected = weekdays.includes(day.value);
						return (
							<button
								key={day.value}
								type="button"
								aria-pressed={selected}
								onClick={() => {
									setWeekdays(
										selected
											? weekdays.filter((value) => value !== day.value)
											: [...weekdays, day.value].toSorted((a, b) => a - b),
									);
									setLocalErrors({});
								}}
								className={cn(
									"rounded-field border px-3 py-1.5 text-sm transition-colors duration-[--motion-fast]",
									"outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
									selected
										? "border-primary bg-accent font-medium text-accent-foreground"
										: "border-border bg-surface text-muted-foreground hover:bg-hover hover:text-foreground",
								)}
							>
								<span className="sr-only">{day.label}</span>
								<span aria-hidden="true">{day.short}</span>
							</button>
						);
					})}
				</div>
				{errors.weekdays ? (
					<p role="alert" className="mt-1.5 text-xs text-danger">
						{errors.weekdays}
					</p>
				) : null}
			</fieldset>

			<FormSection
				title="Between these hours"
				description="24-hour clock, in the condition's timezone. A start later than the end crosses midnight — 22:00 to 06:00 is the night shift."
			>
				<form.Field name="fromTime">
					{(field) => (
						<TextField
							field={field}
							label="From"
							placeholder="09:00"
							disabled={mutation.isPending}
							submitError={errors.fromTime}
						/>
					)}
				</form.Field>
				<form.Field name="toTime">
					{(field) => (
						<TextField
							field={field}
							label="To"
							placeholder="17:00"
							disabled={mutation.isPending}
							submitError={errors.toTime}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="Only on these dates"
				description="For holidays and one-off closures. Leave blank for every date."
			>
				<form.Field name="fromDate">
					{(field) => (
						<TextField
							field={field}
							label="From"
							placeholder="2026-12-24"
							disabled={mutation.isPending}
							submitError={errors.fromDate}
						/>
					)}
				</form.Field>
				<form.Field name="toDate">
					{(field) => (
						<TextField
							field={field}
							label="To"
							placeholder="2026-12-26"
							disabled={mutation.isPending}
							submitError={errors.toDate}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => <SwitchField field={field} label="Enabled" disabled={mutation.isPending} />}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

/** A rule's predicate, in words. Used by the detail table so a rule reads without being opened. */
export function describePredicate(predicate: TimeRulePredicate | undefined): string {
	if (!predicate) {
		return "Matches always";
	}
	const parts: string[] = [];
	if (predicate.weekdays && predicate.weekdays.length > 0) {
		parts.push(
			predicate.weekdays
				.map((day) => WEEKDAYS.find((entry) => entry.value === day)?.short ?? String(day))
				.join(", "),
		);
	}
	if (predicate.timeOfDay) {
		parts.push(`${predicate.timeOfDay.from}–${predicate.timeOfDay.to}`);
	}
	if (predicate.dateRange) {
		parts.push(`${predicate.dateRange.from} to ${predicate.dateRange.to}`);
	}
	if (predicate.months && predicate.months.length > 0) {
		parts.push(`months ${predicate.months.join(", ")}`);
	}
	if (predicate.monthDays && predicate.monthDays.length > 0) {
		parts.push(`days ${predicate.monthDays.join(", ")}`);
	}
	if (predicate.weeksOfMonth && predicate.weeksOfMonth.length > 0) {
		parts.push(`weeks ${predicate.weeksOfMonth.join(", ")}`);
	}
	return parts.length === 0 ? "Matches always" : parts.join(" · ");
}
