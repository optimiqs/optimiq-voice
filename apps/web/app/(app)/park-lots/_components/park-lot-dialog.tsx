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
import { parkLotFormSchema, type ParkLotFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { ParkLotRow } from "~/lib/pbx/contracts";

/**
 * A park lot: a range of slots a call can be put down in, and what happens if nobody picks it up.
 *
 * The slot range is the only pair of REQUIRED integers in the PBX area — every other numeric column
 * has a server default, so an empty input means "use it". Here an empty input is a missing column,
 * which is why the schema treats these two differently from every other number on the form.
 *
 * The timeout trio is the reason this dialog is not two text boxes: a parked call that nobody
 * retrieves has to go somewhere, and without a destination it becomes a caller listening to hold
 * music until the carrier gives up on them.
 */
function defaultsFor(lot: ParkLotRow | null): ParkLotFormValues {
	return {
		name: lot?.name ?? "",
		slotStart: lot === null ? "" : String(lot.slotStart),
		slotEnd: lot === null ? "" : String(lot.slotEnd),
		timeoutSeconds: lot?.timeoutSeconds === undefined ? "" : String(lot.timeoutSeconds),
		enabled: lot?.enabled ?? true,
	};
}

export function ParkLotDialog({
	open,
	onOpenChange,
	lot,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	lot: ParkLotRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.parkLots);
	const update = usePbxUpdate(PBX_RESOURCES.parkLots);
	const mutation = lot === null ? create : update;
	const server = useServerFieldErrors();

	const initialTimeout = lot
		? readDestination(lot as unknown as Record<string, unknown>, "timeout")
		: EMPTY_DESTINATION;
	const [timeoutDestination, setTimeoutDestination] = useState<DestinationValue>(initialTimeout);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(lot),
		validators: { onSubmit: parkLotFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = parkLotFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(timeoutDestination, { required: false });
			if (problem) {
				setLocalErrors({
					[`timeoutDestination${problem.field.charAt(0).toUpperCase()}${problem.field.slice(1)}`]:
						problem.message,
				});
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.name,
				slotStart: parsed.slotStart,
				slotEnd: parsed.slotEnd,
				timeoutSeconds: parsed.timeoutSeconds,
				enabled: parsed.enabled,
				...writeDestination(timeoutDestination, "timeout"),
			};

			try {
				if (lot === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: lot.id, values: body });
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
					setTimeoutDestination(initialTimeout);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={lot === null ? "New park lot" : `Edit ${lot.name}`}
			description="Where a parked call sits, and what happens when nobody comes back for it."
			submitLabel={lot === null ? "Create park lot" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="A call-park feature code can pin this lot, or leave the lot empty to park in the first one with a free slot. Music-on-hold is stored on the lot but has no picker yet; saving here leaves it as it is."
		>
			<FormSection title="Lot">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={lot === null}
							placeholder="Reception"
							disabled={mutation.isPending}
							submitError={errors.name}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="slotStart">
					{(field) => (
						<TextField
							field={field}
							label="First slot"
							required
							placeholder="701"
							description="The lowest number a parked call can be retrieved on."
							disabled={mutation.isPending}
							submitError={errors.slotStart}
						/>
					)}
				</form.Field>
				<form.Field name="slotEnd">
					{(field) => (
						<TextField
							field={field}
							label="Last slot"
							required
							placeholder="720"
							description="Inclusive. Every slot in the range is dialable to pick a call back up."
							disabled={mutation.isPending}
							submitError={errors.slotEnd}
						/>
					)}
				</form.Field>
				<form.Field name="timeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Park for (seconds)"
							placeholder="120"
							description="How long a call may sit here before the destination below is taken."
							disabled={mutation.isPending}
							submitError={errors.timeoutSeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="timeout"
				label="When nobody comes back for the call"
				description="Usually the extension that parked it, or a ring group. Leave it empty to hang up on a caller nobody retrieved — which is rarely what anyone means."
				value={timeoutDestination}
				onChange={(next) => {
					setTimeoutDestination(next);
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
							description="A disabled lot takes no calls; a feature code pinned to it stops parking."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
