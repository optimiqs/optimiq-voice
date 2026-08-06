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
import { phoneNumberFormSchema, type PhoneNumberFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { PhoneNumberRow } from "~/lib/pbx/contracts";

/**
 * Create and edit a DID.
 *
 * A number's destination is REQUIRED and it is the whole point of the record: a DID with nowhere
 * to go is a number that rings into silence. It is also the default the routing compiler falls
 * back to when no inbound route matches, which is why it sits in its own section rather than
 * among the toggles.
 *
 * The destination lives in local state rather than in the form, because it is three fields that
 * are only valid as a set — a type, a ref and a payload where two of the three are mutually
 * exclusive. Putting it through TanStack Form as three independent fields would let the form
 * report "valid" for a combination the database's check constraint refuses.
 */
function defaultsFor(number: PhoneNumberRow | null): PhoneNumberFormValues {
	return {
		e164: number?.e164 ?? "",
		label: number?.label ?? "",
		callerIdNamePrefix: number?.callerIdNamePrefix ?? "",
		recordEnabled: number?.recordEnabled ?? false,
		voiceEnabled: number?.voiceEnabled ?? true,
		faxEnabled: number?.faxEnabled ?? false,
		enabled: number?.enabled ?? true,
	};
}

export function PhoneNumberDialog({
	open,
	onOpenChange,
	number,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	number: PhoneNumberRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.phoneNumbers);
	const update = usePbxUpdate(PBX_RESOURCES.phoneNumbers);
	const mutation = number === null ? create : update;
	const server = useServerFieldErrors();

	const initialDestination = number
		? readDestination(number as unknown as Record<string, unknown>, "")
		: EMPTY_DESTINATION;
	const [destination, setDestination] = useState<DestinationValue>(initialDestination);
	const [destinationError, setDestinationError] = useState<string | undefined>(undefined);

	const form = useForm({
		defaultValues: defaultsFor(number),
		validators: { onSubmit: phoneNumberFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = phoneNumberFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(destination, { required: true });
			if (problem) {
				setDestinationError(problem.message);
				return;
			}
			setDestinationError(undefined);

			const body = {
				e164: parsed.e164,
				label: parsed.label,
				callerIdNamePrefix: parsed.callerIdNamePrefix,
				recordEnabled: parsed.recordEnabled,
				voiceEnabled: parsed.voiceEnabled,
				faxEnabled: parsed.faxEnabled,
				enabled: parsed.enabled,
				...writeDestination(destination, ""),
			};

			try {
				if (number === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: number.id, values: body });
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
					// Reset on CLOSE, not on open: a dialog that clears itself as it fades out looks
					// finished, whereas clearing on open flashes the previous row's values first.
					server.clear();
					mutation.reset();
					setDestinationError(undefined);
					setDestination(initialDestination);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={number === null ? "New number" : `Edit ${number.e164}`}
			description="A DID the carrier delivers to you, and where calls to it go when no inbound route matches."
			submitLabel={number === null ? "Add number" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
		>
			<FormSection title="The number">
				<form.Field name="e164">
					{(field) => (
						<TextField
							field={field}
							label="Number"
							required
							autoFocus={number === null}
							placeholder="+12125550100"
							description="E.164, with the country code."
							disabled={mutation.isPending}
							submitError={server.errors.e164}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Main line"
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdNamePrefix">
					{(field) => (
						<TextField
							field={field}
							label="Caller ID prefix"
							placeholder="[Support] "
							description="Prefixed onto the inbound caller's name, so staff can see which line rang."
							disabled={mutation.isPending}
							submitError={server.errors.callerIdNamePrefix}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="Default destination"
				description="Where a call to this number goes when no inbound route matches it. Required."
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

			<FormSection title="Capabilities" columns={1}>
				<form.Field name="voiceEnabled">
					{(field) => <SwitchField field={field} label="Voice" disabled={mutation.isPending} />}
				</form.Field>
				<form.Field name="faxEnabled">
					{(field) => <SwitchField field={field} label="Fax" disabled={mutation.isPending} />}
				</form.Field>
				<form.Field name="recordEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Record calls to this number"
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled number is ignored by every route."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
