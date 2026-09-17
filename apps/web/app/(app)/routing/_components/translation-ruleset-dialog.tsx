"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { translationRulesetFormSchema, type TranslationRulesetFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { TranslationRulesetRow } from "~/lib/pbx/contracts";

/**
 * A ruleset is a NAME for a pipeline. Everything that does anything is in its rules, which live on
 * the ruleset's own page because they are ordered and reorderable.
 */
function defaultsFor(ruleset: TranslationRulesetRow | null): TranslationRulesetFormValues {
	return {
		name: ruleset?.name ?? "",
		description: ruleset?.description ?? "",
		enabled: ruleset?.enabled ?? true,
	};
}

export function TranslationRulesetDialog({
	open,
	onOpenChange,
	ruleset,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	ruleset: TranslationRulesetRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.translationRulesets);
	const update = usePbxUpdate(PBX_RESOURCES.translationRulesets);
	const mutation = ruleset === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(ruleset),
		validators: { onSubmit: translationRulesetFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = translationRulesetFormSchema.parse(value);
			server.clear();
			try {
				if (ruleset === null) {
					await create.mutateAsync(parsed);
				} else {
					await update.mutateAsync({ id: ruleset.id, values: parsed });
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
			title={ruleset === null ? "New translation ruleset" : `Edit ${ruleset.name}`}
			description="A named, ordered list of rewrites that outbound routes and trunks can share."
			submitLabel={ruleset === null ? "Create ruleset" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="Disabling a ruleset stops every rewrite it performs, on every route and trunk that carries it — which is a change to what digits reach your carriers, not a cosmetic one."
		>
			<FormSection title="Ruleset" columns={1}>
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={ruleset === null}
							placeholder="E.164 normalisation"
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
							rows={3}
							placeholder="What this pipeline turns a number into, and which carriers expect it."
							description="Optional, and worth writing: the next person to attach this to a trunk will only have the name to go on."
							disabled={mutation.isPending}
							submitError={server.errors.description}
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
							description="A disabled ruleset rewrites nothing; numbers reach the carrier as the route produced them."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
