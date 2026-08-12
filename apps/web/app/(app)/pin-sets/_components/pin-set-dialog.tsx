"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { PromptSelect } from "~/components/pbx/resource-select";
import { SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { pinSetFormSchema, type PinSetFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { PinSetRow } from "~/lib/pbx/contracts";

/**
 * A PIN set: the challenge, not the codes.
 *
 * Nothing on this form reaches a secret and nothing on it could. The codes live on the entries, are
 * stored as scrypt digests through an endpoint that hashes them, and never come back out — which is
 * the whole reason this feature exists rather than upstream's plaintext column. What is here is what
 * a caller experiences: what they hear, how many tries they get, and how long they have to type.
 */
function defaultsFor(set: PinSetRow | null): PinSetFormValues {
	return {
		name: set?.name ?? "",
		description: set?.description ?? "",
		promptId: set?.promptId ?? "",
		failurePromptId: set?.failurePromptId ?? "",
		maxAttempts: set?.maxAttempts === undefined ? "" : String(set.maxAttempts),
		digitTimeoutMs: set?.digitTimeoutMs === undefined ? "" : String(set.digitTimeoutMs),
		enabled: set?.enabled ?? true,
	};
}

export function PinSetDialog({
	open,
	onOpenChange,
	pinSet,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pinSet: PinSetRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.pinSets);
	const update = usePbxUpdate(PBX_RESOURCES.pinSets);
	const mutation = pinSet === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(pinSet),
		validators: { onSubmit: pinSetFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = pinSetFormSchema.parse(value);
			server.clear();
			try {
				if (pinSet === null) {
					await create.mutateAsync(parsed);
				} else {
					await update.mutateAsync({ id: pinSet.id, values: parsed });
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
					form.reset();
				}
				onOpenChange(next);
			}}
			title={pinSet === null ? "New PIN set" : `Edit ${pinSet.name}`}
			description="A list of authorisation codes an outbound route can demand before it dials a carrier."
			submitLabel={pinSet === null ? "Create PIN set" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="The codes themselves are added on this set's own page. They are hashed on the way in and are never shown again — a call record names which code authorised a call, never the digits."
		>
			<FormSection title="Set" columns={1}>
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={pinSet === null}
							placeholder="International calling"
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextareaField
							field={field}
							label="Description"
							rows={2}
							placeholder="Who holds these codes, and what they are allowed to spend."
							disabled={mutation.isPending}
							submitError={server.errors.description}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="What the caller hears">
				<form.Field name="promptId">
					{(field) => (
						<PromptSelect
							id="pinSetPromptId"
							label="Ask for the code"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The deployment default"
							description="Played when the route demands a code."
							disabled={mutation.isPending}
							error={server.errors.promptId}
						/>
					)}
				</form.Field>
				<form.Field name="failurePromptId">
					{(field) => (
						<PromptSelect
							id="pinSetFailurePromptId"
							label="Wrong code"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The deployment default"
							description="Played after a wrong entry, before the caller is asked again."
							disabled={mutation.isPending}
							error={server.errors.failurePromptId}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Entry">
				<form.Field name="maxAttempts">
					{(field) => (
						<TextField
							field={field}
							label="Attempts allowed"
							placeholder="3"
							description="Three is the telephone answer, and the ceiling matters: a four-digit code behind unbounded retries can be brute forced during one long call, at no cost to whoever is trying."
							disabled={mutation.isPending}
							submitError={server.errors.maxAttempts}
						/>
					)}
				</form.Field>
				<form.Field name="digitTimeoutMs">
					{(field) => (
						<TextField
							field={field}
							label="Digit timeout (ms)"
							placeholder="8000"
							description="How long the caller has between keypresses before the entry is given up on."
							disabled={mutation.isPending}
							submitError={server.errors.digitTimeoutMs}
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
							description="Disabling a set removes the challenge from every route that carries it, which widens who can dial those routes rather than narrowing it."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
