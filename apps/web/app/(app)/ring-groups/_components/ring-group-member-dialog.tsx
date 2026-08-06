"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { ringGroupMemberFormSchema, type RingGroupMemberFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { RingGroupMemberRow, RingGroupStrategy } from "~/lib/pbx/contracts";

/**
 * One member of a ring group.
 *
 * A member is a DESTINATION, not an extension id — which is what lets a group ring a mobile over
 * a trunk, or fall into another group. The delay is what makes a sequential group sequential; on
 * a simultaneous group it should be zero, and the form says so rather than hiding the field,
 * because the strategy can be changed later and a hidden non-zero delay would then surprise.
 */
function defaultsFor(
	member: RingGroupMemberRow | null,
	nextOrdinal: number,
): RingGroupMemberFormValues {
	return {
		ordinal: member === null ? String(nextOrdinal) : String(member.ordinal),
		delaySeconds: member === null ? "" : String(member.delaySeconds),
		timeoutSeconds: member === null ? "" : String(member.timeoutSeconds),
		confirmRequired: member?.confirmRequired ?? false,
		enabled: member?.enabled ?? true,
	};
}

export function RingGroupMemberDialog({
	open,
	onOpenChange,
	groupId,
	strategy,
	member,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groupId: string;
	strategy: RingGroupStrategy;
	member: RingGroupMemberRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.ringGroupMembers;
	const create = usePbxChildCreate(child, "ring-groups", groupId);
	const update = usePbxChildUpdate(child, "ring-groups", groupId);
	const mutation = member === null ? create : update;
	const server = useServerFieldErrors();

	const initialDestination = member
		? readDestination(member as unknown as Record<string, unknown>, "")
		: EMPTY_DESTINATION;
	const [destination, setDestination] = useState<DestinationValue>(initialDestination);
	const [destinationError, setDestinationError] = useState<string | undefined>(undefined);

	const form = useForm({
		defaultValues: defaultsFor(member, nextOrdinal),
		validators: { onSubmit: ringGroupMemberFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = ringGroupMemberFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(destination, { required: true });
			if (problem) {
				setDestinationError(problem.message);
				return;
			}
			setDestinationError(undefined);

			const body = {
				ordinal: parsed.ordinal ?? 0,
				delaySeconds: parsed.delaySeconds ?? undefined,
				timeoutSeconds: parsed.timeoutSeconds ?? undefined,
				confirmRequired: parsed.confirmRequired,
				enabled: parsed.enabled,
				...writeDestination(destination, ""),
			};

			try {
				if (member === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: member.id, values: body });
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
			title={member === null ? "Add member" : "Edit member"}
			description="Who this group rings, and when."
			submitLabel={member === null ? "Add member" : "Save member"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<DestinationPicker
				prefix=""
				label="Rings"
				description="An extension, another group, or an external number over a trunk."
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

			<FormSection title="Timing">
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Order"
							placeholder="0"
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
						/>
					)}
				</form.Field>
				<form.Field name="delaySeconds">
					{(field) => (
						<TextField
							field={field}
							label="Start ringing after (seconds)"
							placeholder="0"
							description={
								strategy === "simultaneous"
									? "This group rings everyone at once, so leave this at zero."
									: "The delay is what makes a sequential group sequential."
							}
							disabled={mutation.isPending}
							submitError={server.errors.delaySeconds}
						/>
					)}
				</form.Field>
				<form.Field name="timeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Stop ringing after (seconds)"
							placeholder="30"
							disabled={mutation.isPending}
							submitError={server.errors.timeoutSeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="confirmRequired">
					{(field) => (
						<SwitchField
							field={field}
							label="Require confirmation"
							description="This member must press a key to accept, so their voicemail cannot answer for the group."
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
