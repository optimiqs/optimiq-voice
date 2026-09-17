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
	type DestinationPrefix,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { callFlowFormSchema, type CallFlowFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { CallFlowRow } from "~/lib/pbx/contracts";

/**
 * A call flow: two destinations and a switch between them.
 *
 * ## The switch is not on this form, and that is the feature
 *
 * `mode` is absent from both write DTOs on the server, so there is no control here that could move
 * it. Flipping is `POST /call-flows/:id/toggle` behind `call-flows.toggle` — the receptionist's
 * grant — and this dialog is behind `call-flows.write`, the administrator's. A mode select on this
 * form would put the daily action behind the permission that re-points the tenant's inbound calls,
 * and would skip the busy-lamp write that tells every phone in the building the switch moved.
 *
 * ## Both destinations are required
 *
 * The only shape in this area with two REQUIRED trios. Every other secondary trio — a ring group's
 * timeout, an IVR's invalid branch — is a branch a tenant may leave unset, meaning "release the
 * call". A flow's night destination is the other half of the switch, and a flow with one position
 * is not a flow. The server enforces it with a non-optional shape check on nullable columns; this
 * is the half of that sentence a person reads.
 */
function defaultsFor(flow: CallFlowRow | null): CallFlowFormValues {
	return {
		name: flow?.name ?? "",
		extensionNumber: flow?.extensionNumber ?? "",
		featureCode: flow?.featureCode ?? "",
		enabled: flow?.enabled ?? true,
	};
}

/** `timeoutDestinationRef` from `("timeout", "ref")` — the exact key a server issue is addressed at. */
function errorKey(prefix: DestinationPrefix, field: "type" | "ref" | "data"): string {
	const suffix = `${field.charAt(0).toUpperCase()}${field.slice(1)}`;
	return prefix === "" ? `destination${suffix}` : `${prefix}Destination${suffix}`;
}

export function CallFlowDialog({
	open,
	onOpenChange,
	flow,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	flow: CallFlowRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.callFlows);
	const update = usePbxUpdate(PBX_RESOURCES.callFlows);
	const mutation = flow === null ? create : update;
	const server = useServerFieldErrors();

	const asRow = flow as unknown as Record<string, unknown> | null;
	const initialDay = flow ? readDestination(asRow, "") : EMPTY_DESTINATION;
	const initialNight = flow ? readDestination(asRow, "night") : EMPTY_DESTINATION;

	const [day, setDay] = useState<DestinationValue>(initialDay);
	const [night, setNight] = useState<DestinationValue>(initialNight);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(flow),
		validators: { onSubmit: callFlowFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = callFlowFormSchema.parse(value);
			server.clear();

			// Both trios are checked before either is sent, so a form missing both says so twice
			// rather than making the user submit twice to find out.
			const problems: Record<string, string> = {};
			const dayProblem = validateDestinationValue(day, { required: true });
			if (dayProblem) {
				problems[errorKey("", dayProblem.field)] = dayProblem.message;
			}
			const nightProblem = validateDestinationValue(night, { required: true });
			if (nightProblem) {
				problems[errorKey("night", nightProblem.field)] = nightProblem.message;
			}
			if (Object.keys(problems).length > 0) {
				setLocalErrors(problems);
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.name,
				extensionNumber: parsed.extensionNumber,
				featureCode: parsed.featureCode,
				enabled: parsed.enabled,
				...writeDestination(day, ""),
				...writeDestination(night, "night"),
			};

			try {
				if (flow === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: flow.id, values: body });
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
					setDay(initialDay);
					setNight(initialNight);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={flow === null ? "New call flow" : `Edit ${flow.name}`}
			description="Two destinations and a switch. Whoever is on the front desk moves it; this form decides where each position goes."
			submitLabel={flow === null ? "Create call flow" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Which position the flow is in is not set here — it is moved from the list, which is a separate permission and also relights the busy-lamp keys on every handset watching it."
		>
			<FormSection title="Flow">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={flow === null}
							placeholder="Main line"
							disabled={mutation.isPending}
							submitError={errors.name}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="extensionNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="600"
							description="Optional. A flow reached only by its toggle code needs none."
							disabled={mutation.isPending}
							submitError={errors.extensionNumber}
						/>
					)}
				</form.Field>
				<form.Field name="featureCode">
					{(field) => (
						<TextField
							field={field}
							label="Toggle code"
							placeholder="*281"
							description="What a handset dials to move the switch, and the key a busy-lamp is provisioned with. Saving is refused if another feature already answers to it."
							disabled={mutation.isPending}
							submitError={errors.featureCode}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="Day destination"
				description="Where calls go while the switch is in the day position."
				value={day}
				onChange={(next) => {
					setDay(next);
					setLocalErrors({});
				}}
				required
				disabled={mutation.isPending}
				errors={errors}
			/>

			<DestinationPicker
				prefix="night"
				label="Night destination"
				description="Where calls go while the switch is in the night position. Required — a switch with one position is not a switch."
				value={night}
				onChange={(next) => {
					setNight(next);
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
							description="A disabled flow routes nothing, and its toggle code stops answering."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
