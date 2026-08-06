"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { timeConditionFormSchema, type TimeConditionFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { TimeConditionRow } from "~/lib/pbx/contracts";

/**
 * Create and edit a time condition's two branches.
 *
 * A time condition is a fork: when one of its rules matches, the call takes the MATCH
 * destination; otherwise it takes the no-match one. The rules themselves live on the condition's
 * own page, because each is a set of predicates and there may be several.
 *
 * The timezone is not decoration. Every rule is evaluated in it, and an unknown zone fails the
 * compile — which means a typo here is a rolled-back save on some unrelated route later, so it is
 * validated before it is sent.
 */
function defaultsFor(condition: TimeConditionRow | null): TimeConditionFormValues {
	return {
		name: condition?.name ?? "",
		timezone: condition?.timezone ?? guessTimezone(),
		enabled: condition?.enabled ?? true,
	};
}

/** The browser's own zone is the right default far more often than UTC is. */
function guessTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export function TimeConditionDialog({
	open,
	onOpenChange,
	condition,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	condition: TimeConditionRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.timeConditions);
	const update = usePbxUpdate(PBX_RESOURCES.timeConditions);
	const mutation = condition === null ? create : update;
	const server = useServerFieldErrors();

	const asRow = condition as unknown as Record<string, unknown> | null;
	const initialMatch = condition ? readDestination(asRow, "") : EMPTY_DESTINATION;
	const initialNomatch = condition ? readDestination(asRow, "nomatch") : EMPTY_DESTINATION;

	const [match, setMatch] = useState<DestinationValue>(initialMatch);
	const [nomatch, setNomatch] = useState<DestinationValue>(initialNomatch);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(condition),
		validators: { onSubmit: timeConditionFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = timeConditionFormSchema.parse(value);
			server.clear();

			const problems: Record<string, string> = {};
			const matchProblem = validateDestinationValue(match, { required: true });
			if (matchProblem) {
				problems[`destination${capitalize(matchProblem.field)}`] = matchProblem.message;
			}
			const nomatchProblem = validateDestinationValue(nomatch, { required: false });
			if (nomatchProblem) {
				problems[`nomatchDestination${capitalize(nomatchProblem.field)}`] = nomatchProblem.message;
			}
			if (Object.keys(problems).length > 0) {
				setLocalErrors(problems);
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.name,
				timezone: parsed.timezone,
				enabled: parsed.enabled,
				...writeDestination(match, ""),
				...writeDestination(nomatch, "nomatch"),
			};

			try {
				if (condition === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: condition.id, values: body });
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
					setMatch(initialMatch);
					setNomatch(initialNomatch);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={condition === null ? "New time condition" : `Edit ${condition.name}`}
			description="A fork in the routing: one way while the clock says yes, another way otherwise."
			submitLabel={condition === null ? "Create condition" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote={
				condition === null
					? "Rules — the hours and dates this matches — are added on the condition's page once it exists. With no rules, nothing ever matches and every call takes the no-match branch."
					: undefined
			}
		>
			<FormSection title="Condition">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={condition === null}
							placeholder="Business hours"
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="timezone">
					{(field) => (
						<TextField
							field={field}
							label="Timezone"
							required
							placeholder="America/New_York"
							description="An IANA zone. Every rule is read in it; an unknown zone fails the routing compile."
							disabled={mutation.isPending}
							submitError={errors.timezone}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="While a rule matches"
				description="Where the call goes during the hours this condition covers."
				value={match}
				onChange={(next) => {
					setMatch(next);
					setLocalErrors({});
				}}
				required
				disabled={mutation.isPending}
				errors={errors}
			/>

			<DestinationPicker
				prefix="nomatch"
				label="Otherwise"
				description="Where the call goes the rest of the time — after hours, holidays, weekends."
				value={nomatch}
				onChange={(next) => {
					setNomatch(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled condition stops gating: routes using it apply at all times."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
