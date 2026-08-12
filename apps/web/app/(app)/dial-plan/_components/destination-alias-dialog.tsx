"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { destinationAliasFormSchema, type DestinationAliasFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { DestinationAliasRow } from "~/lib/pbx/contracts";

/**
 * A named destination — one name, pointed at one place, referred to from many.
 *
 * FusionPBX calls this a "bridge" and lets it hold a raw FreeSWITCH dial STRING, which is an escape
 * hatch straight past the toll gate: `sofia/gateway/…` reaches a carrier with no route matched, no
 * toll class applied and no screening list consulted. This one names a destination trio instead, so
 * an alias can only point where every other pointer in the system can point.
 */
function defaultsFor(alias: DestinationAliasRow | null): DestinationAliasFormValues {
	return {
		name: alias?.name ?? "",
		description: alias?.description ?? "",
		enabled: alias?.enabled ?? true,
	};
}

export function DestinationAliasDialog({
	open,
	onOpenChange,
	alias,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	alias: DestinationAliasRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.destinationAliases);
	const update = usePbxUpdate(PBX_RESOURCES.destinationAliases);
	const mutation = alias === null ? create : update;
	const server = useServerFieldErrors();

	const initial = alias
		? readDestination(alias as unknown as Record<string, unknown>, "")
		: EMPTY_DESTINATION;
	const [destination, setDestination] = useState<DestinationValue>(initial);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(alias),
		validators: { onSubmit: destinationAliasFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = destinationAliasFormSchema.parse(value);
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
				if (alias === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: alias.id, values: body });
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
			title={alias === null ? "New named destination" : `Edit ${alias.name}`}
			description="A name you can point many routes at, so moving the target later is one edit instead of twenty."
			submitLabel={alias === null ? "Create named destination" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="A named destination is not a step in the call: it compiles away flat, so a call routed through one behaves exactly as if it had pointed at the target directly. An alias that points at another alias is followed, and a loop is refused after eight hops rather than compiled."
		>
			<FormSection title="Name" columns={1}>
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={alias === null}
							placeholder="Front desk"
							description="What the routes that use this will show. Choose the role rather than the target — “Front desk”, not “Extension 1001”."
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextareaField
							field={field}
							label="Description"
							rows={2}
							placeholder="Who or what this stands for, and when it is expected to move."
							disabled={mutation.isPending}
							submitError={errors.description}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="Points at"
				description="Everything naming this alias follows it here. Changing it re-points every one of them at once, which is the entire reason to use one."
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
							description="Disabling breaks every route that names this. There is no fallback — an alias is a pointer, not a branch."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
