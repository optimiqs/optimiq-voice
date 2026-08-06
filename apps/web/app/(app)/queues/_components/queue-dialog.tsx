"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { QUEUE_STRATEGIES } from "~/lib/pbx/contracts";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { queueFormSchema, type QueueFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { QueueRow, QueueStrategy } from "~/lib/pbx/contracts";

/**
 * A queue's settings: how it distributes calls, how long it holds them, and where they go when it
 * runs out of patience.
 *
 * This dialog is gated on `queues.write` and nothing here staffs the queue. Who answers it is a
 * TIER, which is `queues.manage-agents` — a supervisor who staffs the floor is not necessarily the
 * person who may re-point the overflow at an external number, and the API keeps the two apart on
 * purpose. So does this: the agents and tier surfaces are elsewhere, and their buttons ask for the
 * other grant.
 */
const STRATEGY_LABELS: Readonly<Record<QueueStrategy, string>> = {
	"longest-idle": "Offer to whoever has waited longest",
	"ring-all": "Ring every available agent at once",
	"round-robin": "Take turns, in tier order",
	"top-down": "Always start at the top of the tier",
	sequential: "One agent after another",
	random: "Pick an available agent at random",
};

function defaultsFor(queue: QueueRow | null): QueueFormValues {
	const seconds = (value: number | undefined): string => (value === undefined ? "" : String(value));
	return {
		name: queue?.name ?? "",
		extensionNumber: queue?.extensionNumber ?? "",
		strategy: queue?.strategy ?? "longest-idle",
		maxWaitSeconds: seconds(queue?.maxWaitSeconds),
		maxWaitNoAgentSeconds: seconds(queue?.maxWaitNoAgentSeconds),
		wrapUpSeconds: seconds(queue?.wrapUpSeconds),
		announcePositionEnabled: queue?.announcePositionEnabled ?? false,
		announceFrequencySeconds: seconds(queue?.announceFrequencySeconds),
		abandonedResumeAllowed: queue?.abandonedResumeAllowed ?? false,
		discardAbandonedAfterSeconds: seconds(queue?.discardAbandonedAfterSeconds),
		tierRulesApply: queue?.tierRulesApply ?? true,
		tierRuleWaitSeconds: seconds(queue?.tierRuleWaitSeconds),
		tierRuleNoAgentNoWait: queue?.tierRuleNoAgentNoWait ?? false,
		recordEnabled: queue?.recordEnabled ?? false,
		enabled: queue?.enabled ?? true,
	};
}

export function QueueDialog({
	open,
	onOpenChange,
	queue,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	queue: QueueRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.queues);
	const update = usePbxUpdate(PBX_RESOURCES.queues);
	const mutation = queue === null ? create : update;
	const server = useServerFieldErrors();

	const initialTimeout = queue
		? readDestination(queue as unknown as Record<string, unknown>, "timeout")
		: EMPTY_DESTINATION;
	const [timeoutDestination, setTimeoutDestination] = useState<DestinationValue>(initialTimeout);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(queue),
		validators: { onSubmit: queueFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueFormSchema.parse(value);
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

			/**
			 * Every numeric knob is `resettable` on the server: `null` puts it back to the server
			 * default rather than clearing it to NULL, which is what "leave it empty" means on a column
			 * that is `notNull().default(n)`. `undefined` would leave the stored value alone on a
			 * PATCH, which is a different intent and not the one an emptied input expresses.
			 */
			const body = {
				name: parsed.name,
				extensionNumber: parsed.extensionNumber,
				strategy: parsed.strategy,
				maxWaitSeconds: parsed.maxWaitSeconds,
				maxWaitNoAgentSeconds: parsed.maxWaitNoAgentSeconds,
				wrapUpSeconds: parsed.wrapUpSeconds,
				announcePositionEnabled: parsed.announcePositionEnabled,
				announceFrequencySeconds: parsed.announceFrequencySeconds,
				abandonedResumeAllowed: parsed.abandonedResumeAllowed,
				discardAbandonedAfterSeconds: parsed.discardAbandonedAfterSeconds,
				tierRulesApply: parsed.tierRulesApply,
				tierRuleWaitSeconds: parsed.tierRuleWaitSeconds,
				tierRuleNoAgentNoWait: parsed.tierRuleNoAgentNoWait,
				recordEnabled: parsed.recordEnabled,
				enabled: parsed.enabled,
				...writeDestination(timeoutDestination, "timeout"),
			};

			try {
				if (queue === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: queue.id, values: body });
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
			title={queue === null ? "New queue" : `Edit ${queue.name}`}
			description="How the queue distributes calls, how long it holds them, and where they go if it cannot."
			submitLabel={queue === null ? "Create queue" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote={
				queue === null
					? "Agents are staffed on the queue's page once it exists, and that is a separate permission. A queue with nobody in it holds callers until the wait cap and then takes the timeout destination."
					: "Music-on-hold and the greeting and announcement prompts are stored on this queue but have no picker yet; saving here leaves them exactly as they are."
			}
		>
			<FormSection title="Queue">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={queue === null}
							placeholder="Support"
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
							placeholder="7000"
							description="Optional. Lets staff dial the queue directly."
							disabled={mutation.isPending}
							submitError={errors.extensionNumber}
						/>
					)}
				</form.Field>
				<form.Field name="strategy">
					{(field) => (
						<SelectField
							field={field}
							label="Distribution"
							required
							description="Which staffed agent the next call is offered to."
							disabled={mutation.isPending}
							submitError={errors.strategy}
							className="sm:col-span-2"
						>
							{QUEUE_STRATEGIES.map((value) => (
								<option key={value} value={value}>
									{STRATEGY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="Waiting"
				description="Both caps are in seconds, and 0 means no cap at all — the caller waits until they hang up."
			>
				<form.Field name="maxWaitSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Give up after"
							placeholder="0"
							description="Takes the timeout destination below."
							disabled={mutation.isPending}
							submitError={errors.maxWaitSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="maxWaitNoAgentSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Give up when nobody is logged in"
							placeholder="0"
							description="A shorter cap for the case where waiting cannot possibly help."
							disabled={mutation.isPending}
							submitError={errors.maxWaitNoAgentSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="wrapUpSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Wrap-up time"
							placeholder="10"
							description="How long an agent is left alone after a call before the queue offers them another."
							disabled={mutation.isPending}
							submitError={errors.wrapUpSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="discardAbandonedAfterSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Forget an abandoned caller after"
							placeholder="60"
							description="How long a caller who hung up may call back and keep their place."
							disabled={mutation.isPending}
							submitError={errors.discardAbandonedAfterSeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="timeout"
				label="When the wait runs out"
				description="Taken when either cap above expires. Leave it empty to hang up on the caller — which is rarely what anyone wants."
				value={timeoutDestination}
				onChange={(next) => {
					setTimeoutDestination(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="Announcements">
				<form.Field name="announceFrequencySeconds">
					{(field) => (
						<TextField
							field={field}
							label="Announce every (seconds)"
							placeholder="30"
							disabled={mutation.isPending}
							submitError={errors.announceFrequencySeconds}
						/>
					)}
				</form.Field>
				<form.Field name="announcePositionEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Tell callers their position"
							description="Read out where they are in the queue at the interval above."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="Tier rules"
				description="How the queue walks down the tiers when the level it is on does not answer."
				columns={1}
			>
				<form.Field name="tierRulesApply">
					{(field) => (
						<SwitchField
							field={field}
							label="Walk down the tiers"
							description="Off means every staffed agent is treated as one flat tier, whatever their level says."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="tierRuleWaitSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Wait on each tier (seconds)"
							placeholder="10"
							description="How long a level is given before the next one is brought in."
							disabled={mutation.isPending}
							submitError={errors.tierRuleWaitSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="tierRuleNoAgentNoWait">
					{(field) => (
						<SwitchField
							field={field}
							label="Skip a tier with nobody in it"
							description="Do not spend the tier wait on a level where no agent is available."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="abandonedResumeAllowed">
					{(field) => (
						<SwitchField
							field={field}
							label="Let a caller who hung up keep their place"
							description="Within the discard window above."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="recordEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Record calls answered from this queue"
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
