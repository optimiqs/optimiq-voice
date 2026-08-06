"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { RING_GROUP_STRATEGIES } from "~/lib/pbx/contracts";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { ringGroupFormSchema, type RingGroupFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { RingGroupRow, RingGroupStrategy } from "~/lib/pbx/contracts";

/**
 * Create and edit a ring group's settings.
 *
 * A ring group with no members is legal and saves — the routing compiler returns a WARNING rather
 * than refusing it, because an empty group during setup is a normal intermediate state. The
 * warning is surfaced on the members panel, not swallowed: a group that rings nobody and then
 * takes its timeout branch is a support call waiting to happen.
 */
const STRATEGY_LABELS: Readonly<Record<RingGroupStrategy, string>> = {
	simultaneous: "Ring everyone at once",
	sequential: "Ring one after another",
};

function defaultsFor(group: RingGroupRow | null): RingGroupFormValues {
	return {
		name: group?.name ?? "",
		extensionNumber: group?.extensionNumber ?? "",
		strategy: group?.strategy ?? "simultaneous",
		ringTimeoutSeconds:
			group?.ringTimeoutSeconds === undefined ? "" : String(group.ringTimeoutSeconds),
		callerIdNamePrefix: group?.callerIdNamePrefix ?? "",
		ignoreBusy: group?.ignoreBusy ?? false,
		confirmEnabled: group?.confirmEnabled ?? false,
		enabled: group?.enabled ?? true,
	};
}

export function RingGroupDialog({
	open,
	onOpenChange,
	group,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	group: RingGroupRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.ringGroups);
	const update = usePbxUpdate(PBX_RESOURCES.ringGroups);
	const mutation = group === null ? create : update;
	const server = useServerFieldErrors();

	const initialTimeout = group
		? readDestination(group as unknown as Record<string, unknown>, "timeout")
		: EMPTY_DESTINATION;
	const [timeoutDestination, setTimeoutDestination] = useState<DestinationValue>(initialTimeout);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(group),
		validators: { onSubmit: ringGroupFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = ringGroupFormSchema.parse(value);
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
				extensionNumber: parsed.extensionNumber,
				strategy: parsed.strategy,
				ringTimeoutSeconds: parsed.ringTimeoutSeconds ?? undefined,
				callerIdNamePrefix: parsed.callerIdNamePrefix,
				ignoreBusy: parsed.ignoreBusy,
				confirmEnabled: parsed.confirmEnabled,
				enabled: parsed.enabled,
				...writeDestination(timeoutDestination, "timeout"),
			};

			try {
				if (group === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: group.id, values: body });
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
			title={group === null ? "New ring group" : `Edit ${group.name}`}
			description="Who rings, in what order, and what happens when none of them answer."
			submitLabel={group === null ? "Create ring group" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote={
				group === null
					? "Members are added on the group's page once it exists. Saving an empty group is allowed — you will get a warning saying it rings nobody."
					: undefined
			}
		>
			<FormSection title="Group">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={group === null}
							placeholder="Sales"
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="extensionNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="6000"
							description="Optional. Lets staff dial the group directly."
							disabled={mutation.isPending}
							submitError={errors.extensionNumber}
						/>
					)}
				</form.Field>
				<form.Field name="strategy">
					{(field) => (
						<SelectField
							field={field}
							label="Ring strategy"
							disabled={mutation.isPending}
							submitError={errors.strategy}
						>
							{RING_GROUP_STRATEGIES.map((value) => (
								<option key={value} value={value}>
									{STRATEGY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="ringTimeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Ring for (seconds)"
							placeholder="30"
							description="After this, the timeout destination below is taken."
							disabled={mutation.isPending}
							submitError={errors.ringTimeoutSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdNamePrefix">
					{(field) => (
						<TextField
							field={field}
							label="Caller ID prefix"
							placeholder="[Sales] "
							description="Prefixed onto the caller's name so members can see which group rang."
							disabled={mutation.isPending}
							submitError={errors.callerIdNamePrefix}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="timeout"
				label="When nobody answers"
				description="Taken once the ring time above is used up. Leave empty to hang up."
				value={timeoutDestination}
				onChange={(next) => {
					setTimeoutDestination(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="ignoreBusy">
					{(field) => (
						<SwitchField
							field={field}
							label="Skip members already on a call"
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="confirmEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Ask the member to confirm"
							description="The member presses a key to accept, so a voicemail box cannot answer for them."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => <SwitchField field={field} label="Enabled" disabled={mutation.isPending} />}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
