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
import { speedDialFormSchema, type SpeedDialFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { SpeedDialRow } from "~/lib/pbx/contracts";

/**
 * An organization-wide short code.
 *
 * The target is a destination TRIO rather than a number, for the reason a named destination refuses
 * a dial string: a bare number would have to be dialled by something, with no route matched and no
 * toll class applied — which is a way around the outbound tables wearing a convenience feature's
 * name. To reach an outside number, choose "External number" and the call goes out through the
 * ordinary outbound routing, screened and priced like any other.
 *
 * Nothing points AT a speed dial, so it never appears in a destination picker.
 */
function defaultsFor(speedDial: SpeedDialRow | null): SpeedDialFormValues {
	return {
		code: speedDial?.code ?? "",
		label: speedDial?.label ?? "",
		enabled: speedDial?.enabled ?? true,
	};
}

export function SpeedDialDialog({
	open,
	onOpenChange,
	speedDial,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	speedDial: SpeedDialRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.speedDials);
	const update = usePbxUpdate(PBX_RESOURCES.speedDials);
	const mutation = speedDial === null ? create : update;
	const server = useServerFieldErrors();

	const initial = speedDial
		? readDestination(speedDial as unknown as Record<string, unknown>, "")
		: EMPTY_DESTINATION;
	const [destination, setDestination] = useState<DestinationValue>(initial);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(speedDial),
		validators: { onSubmit: speedDialFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = speedDialFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(destination, { required: true });
			if (problem) {
				setLocalErrors({
					[`destination${problem.field.charAt(0).toUpperCase()}${problem.field.slice(1)}`]:
						problem.message,
				});
				return;
			}
			setLocalErrors({});

			const body = { ...parsed, ...writeDestination(destination, "") };
			try {
				if (speedDial === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: speedDial.id, values: body });
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
					setDestination(initial);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={speedDial === null ? "New speed dial" : `Edit ${speedDial.code}`}
			description="A short code every handset in the organization can dial to reach one place."
			submitLabel={speedDial === null ? "Create speed dial" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Saving is refused if these digits already answer to a feature code or an internal number — that check runs against the whole organization when you save, not against this form."
		>
			<FormSection title="Code">
				<form.Field name="code">
					{(field) => (
						<TextField
							field={field}
							label="Dial"
							required
							autoFocus={speedDial === null}
							placeholder="*01"
							description="Digits, optionally led by * or #. Both *01 and 8001 are accepted; * codes share the space feature codes use, which is why the collision check runs on save."
							disabled={mutation.isPending}
							submitError={errors.code}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							required
							placeholder="Head office"
							description="What this reaches, in words. It is what a handset's directory will show."
							disabled={mutation.isPending}
							submitError={errors.label}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="Reaches"
				description="For an outside number choose “External number” — the call still goes out through your outbound routes, screened and priced like any other."
				value={destination}
				onChange={(next) => {
					setDestination(next);
					setLocalErrors({});
				}}
				required
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="Disabling frees the code. Handsets dialling it get whatever normal routing does with those digits, which is usually nothing."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
