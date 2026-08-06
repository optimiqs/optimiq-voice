"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { ivrOptionFormSchema, type IvrOptionFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { IvrMenuOptionRow, IvrOptionMatchKind } from "~/lib/pbx/contracts";

/**
 * One digit option on an IVR menu.
 *
 * The destination is REQUIRED — an option that matches a digit and then goes nowhere is worse
 * than no option at all, because the caller pressed something and the call stalls. `ordinal` is
 * the evaluation order; it is exposed because a `regex` option placed before a `digit` one will
 * swallow it, and that is not something the compiler can guess a preference about.
 */
const MATCH_KIND_LABELS: Readonly<Record<IvrOptionMatchKind, string>> = {
	digit: "A single digit",
	regex: "A pattern",
};

function defaultsFor(option: IvrMenuOptionRow | null, nextOrdinal: number): IvrOptionFormValues {
	return {
		ordinal: option === null ? String(nextOrdinal) : String(option.ordinal),
		matchKind: option?.matchKind ?? "digit",
		matchValue: option?.matchValue ?? "",
		label: option?.label ?? "",
		enabled: option?.enabled ?? true,
	};
}

export function IvrOptionDialog({
	open,
	onOpenChange,
	menuId,
	option,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	menuId: string;
	option: IvrMenuOptionRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.ivrOptions;
	const create = usePbxChildCreate(child, "ivr-menus", menuId);
	const update = usePbxChildUpdate(child, "ivr-menus", menuId);
	const mutation = option === null ? create : update;
	const server = useServerFieldErrors();

	const initialDestination = option
		? readDestination(option as unknown as Record<string, unknown>, "")
		: EMPTY_DESTINATION;
	const [destination, setDestination] = useState<DestinationValue>(initialDestination);
	const [destinationError, setDestinationError] = useState<string | undefined>(undefined);

	const form = useForm({
		defaultValues: defaultsFor(option, nextOrdinal),
		validators: { onSubmit: ivrOptionFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = ivrOptionFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(destination, { required: true });
			if (problem) {
				setDestinationError(problem.message);
				return;
			}
			setDestinationError(undefined);

			const body = {
				ordinal: parsed.ordinal ?? 0,
				matchKind: parsed.matchKind,
				matchValue: parsed.matchValue,
				label: parsed.label,
				enabled: parsed.enabled,
				...writeDestination(destination, ""),
			};

			try {
				if (option === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: option.id, values: body });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					server.clear();
					mutation.reset();
					setDestinationError(undefined);
					setDestination(initialDestination);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={option === null ? "Add option" : `Edit option ${option.matchValue}`}
			description="What the caller presses, and where it takes them."
			submitLabel={option === null ? "Add option" : "Save option"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<FormSection title="The key">
				<form.Field name="matchKind">
					{(field) => (
						<SelectField
							field={field}
							label="Matches"
							disabled={mutation.isPending}
							submitError={server.errors.matchKind}
						>
							{(Object.keys(MATCH_KIND_LABELS) as IvrOptionMatchKind[]).map((value) => (
								<option key={value} value={value}>
									{MATCH_KIND_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="matchValue">
					{(field) => (
						<TextField
							field={field}
							label="Key or pattern"
							required
							autoFocus={option === null}
							placeholder="1"
							disabled={mutation.isPending}
							submitError={server.errors.matchValue}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Sales"
							description="What this option is for. Shown here, not to the caller."
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Order"
							placeholder="0"
							description="Lowest first. A pattern placed above a digit will swallow it."
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="Sends the caller to"
				value={destination}
				onChange={(next) => {
					setDestination(next);
					setDestinationError(undefined);
				}}
				required
				disabled={mutation.isPending}
				errors={{
					...server.errors,
					...(destinationError === undefined ? {} : { destinationType: destinationError }),
				}}
			/>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled option is not offered; the caller pressing it falls through to the invalid branch."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
