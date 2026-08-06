"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { QUEUE_AGENT_CONTACT_KINDS, QUEUE_AGENT_STATUSES } from "~/lib/pbx/contracts";
import { queueAgentFormSchema, type QueueAgentFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import { AGENT_STATUS_LABELS } from "./queue-shared";
import type { QueueAgentContactKind, QueueAgentRow } from "~/lib/pbx/contracts";

/**
 * An agent: a person the engine can offer a queued call to.
 *
 * An agent belongs to the ORGANIZATION, not to a queue — `queue_agent` carries no queue id, and a
 * tier is what says which queues they serve. So this dialog never mentions one: creating an agent
 * here staffs nothing until a tier exists, and deleting one removes them from every queue at once,
 * which is what "this person has left" means.
 *
 * `status` is writable because a supervisor forcing an agent out of a queue is a real operation —
 * it is precisely what `queues.manage-agents` grants. `statusChangedAt` is not, because a form that
 * could backdate it would make every wallboard's "on this call for 12 minutes" a number the agent
 * chose.
 */
const CONTACT_KIND_LABELS: Readonly<Record<QueueAgentContactKind, string>> = {
	extension: "An extension in this organization",
	external: "An external number",
};

function defaultsFor(agent: QueueAgentRow | null): QueueAgentFormValues {
	const seconds = (value: number | undefined): string => (value === undefined ? "" : String(value));
	return {
		name: agent?.name ?? "",
		contactKind: agent?.contactKind ?? "extension",
		extensionId: agent?.extensionId ?? "",
		contact: agent?.contact ?? "",
		status: agent?.status ?? "logged-out",
		wrapUpSeconds: seconds(agent?.wrapUpSeconds),
		maxNoAnswer: seconds(agent?.maxNoAnswer),
		noAnswerDelaySeconds: seconds(agent?.noAnswerDelaySeconds),
		busyDelaySeconds: seconds(agent?.busyDelaySeconds),
		rejectDelaySeconds: seconds(agent?.rejectDelaySeconds),
		enabled: agent?.enabled ?? true,
	};
}

export function QueueAgentDialog({
	open,
	onOpenChange,
	agent,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agent: QueueAgentRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.queueAgents);
	const update = usePbxUpdate(PBX_RESOURCES.queueAgents);
	const mutation = agent === null ? create : update;
	const server = useServerFieldErrors();

	/**
	 * The extension lives outside the form because it is a `ResourceSelect` rather than a field
	 * adapter — the same arrangement the inbound-route dialog uses for its phone number.
	 */
	const [extensionId, setExtensionId] = useState(agent?.extensionId ?? "");

	const form = useForm({
		defaultValues: defaultsFor(agent),
		validators: { onSubmit: queueAgentFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueAgentFormSchema.parse({ ...value, extensionId });
			server.clear();

			/**
			 * Only the half the contact kind names is sent, and the other is explicitly cleared. An
			 * agent switched from `external` back to `extension` that still carried the old dial string
			 * would be a row whose second column nothing reads — dead configuration that reads as a
			 * setting, exactly what the destination trio's writer exists to prevent.
			 */
			const body = {
				name: parsed.name,
				contactKind: parsed.contactKind,
				extensionId: parsed.contactKind === "extension" ? parsed.extensionId : null,
				contact: parsed.contactKind === "external" ? parsed.contact : null,
				status: parsed.status,
				wrapUpSeconds: parsed.wrapUpSeconds,
				maxNoAnswer: parsed.maxNoAnswer,
				noAnswerDelaySeconds: parsed.noAnswerDelaySeconds,
				busyDelaySeconds: parsed.busyDelaySeconds,
				rejectDelaySeconds: parsed.rejectDelaySeconds,
				enabled: parsed.enabled,
			};

			try {
				if (agent === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: agent.id, values: body });
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
					setExtensionId(agent?.extensionId ?? "");
					form.reset();
				}
				onOpenChange(next);
			}}
			title={agent === null ? "New agent" : `Edit ${agent.name}`}
			description="Someone a queued call can be offered to, and how hard the queue tries them."
			submitLabel={agent === null ? "Create agent" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="An agent serves a queue through a tier. Creating one here staffs nothing until it is assigned; deleting one removes it from every queue it served."
		>
			<FormSection title="Agent">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={agent === null}
							placeholder="Alice Chen"
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="status">
					{(field) => (
						<SelectField
							field={field}
							label="Status"
							description="Where this agent stands right now. Setting it here is a supervisor action."
							disabled={mutation.isPending}
							submitError={server.errors.status}
						>
							{QUEUE_AGENT_STATUSES.map((value) => (
								<option key={value} value={value}>
									{AGENT_STATUS_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="How the queue reaches them"
				description="One or the other, never both — an agent the engine cannot dial is a seat that silently never rings."
			>
				<form.Field name="contactKind">
					{(field) => (
						<SelectField
							field={field}
							label="Reached by"
							required
							disabled={mutation.isPending}
							submitError={server.errors.contactKind}
						>
							{QUEUE_AGENT_CONTACT_KINDS.map((value) => (
								<option key={value} value={value}>
									{CONTACT_KIND_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Subscribe selector={(state) => state.values.contactKind}>
					{(contactKind) =>
						contactKind === "extension" ? (
							<ResourceSelect
								id="extensionId"
								label="Extension"
								resource={PBX_RESOURCES.extensions}
								value={extensionId}
								onChange={setExtensionId}
								allowEmpty={false}
								disabled={mutation.isPending}
								error={server.errors.extensionId}
							/>
						) : (
							<form.Field name="contact">
								{(field) => (
									<TextField
										field={field}
										label="Number to dial"
										required
										placeholder="+12125550100"
										description="Dialled over whatever outbound route covers it."
										disabled={mutation.isPending}
										submitError={server.errors.contact}
									/>
								)}
							</form.Field>
						)
					}
				</form.Subscribe>
			</FormSection>

			<FormSection
				title="No-answer penalties"
				description="How long this agent is skipped after each way of not taking a call. All in seconds."
			>
				<form.Field name="maxNoAnswer">
					{(field) => (
						<TextField
							field={field}
							label="Missed calls before they are pulled out"
							placeholder="3"
							disabled={mutation.isPending}
							submitError={server.errors.maxNoAnswer}
						/>
					)}
				</form.Field>
				<form.Field name="wrapUpSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Wrap-up after a call"
							placeholder="10"
							description="Overrides the queue's own wrap-up time for this agent."
							disabled={mutation.isPending}
							submitError={server.errors.wrapUpSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="noAnswerDelaySeconds">
					{(field) => (
						<TextField
							field={field}
							label="After no answer"
							placeholder="30"
							disabled={mutation.isPending}
							submitError={server.errors.noAnswerDelaySeconds}
						/>
					)}
				</form.Field>
				<form.Field name="busyDelaySeconds">
					{(field) => (
						<TextField
							field={field}
							label="After busy"
							placeholder="30"
							disabled={mutation.isPending}
							submitError={server.errors.busyDelaySeconds}
						/>
					)}
				</form.Field>
				<form.Field name="rejectDelaySeconds">
					{(field) => (
						<TextField
							field={field}
							label="After a rejected call"
							placeholder="30"
							disabled={mutation.isPending}
							submitError={server.errors.rejectDelaySeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled agent is never offered a call, whatever their status or tiers say."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
