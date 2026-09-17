"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { translationRuleFormSchema, type TranslationRuleFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { TranslationRuleRow } from "~/lib/pbx/contracts";

/**
 * One rewrite in a pipeline.
 *
 * ## Nothing here validates the regular expression, and that is on purpose
 *
 * `validateTranslationRule` in `@optimiq-voice/routing` is what decides whether a rule can be
 * APPLIED — it compiles the pattern, and it checks that the replacement can only ever emit dialable
 * output — and the API runs it inside the write transaction. A `new RegExp(...)` in the browser
 * would be a second opinion that agrees today and disagrees the first time somebody writes a
 * lookbehind, and the replacement allow-list is a security boundary rather than a formatting rule:
 * a replacement that can emit `@` is a rule that could put a second host into a request URI. So this
 * form bounds the LENGTH, and an unusable rule comes back as a 422 addressed at the field with the
 * compiler's own wording.
 *
 * ## An empty replacement is a feature
 *
 * That is how a strip rule is written — match the prefix, replace it with nothing. The field is
 * therefore not required and is not cleared to `null`: the column is `z.string().max(256)` on the
 * server, and `null` would be a 400.
 */
function defaultsFor(
	rule: TranslationRuleRow | null,
	nextOrdinal: number,
): TranslationRuleFormValues {
	return {
		label: rule?.label ?? "",
		matchPattern: rule?.matchPattern ?? "",
		replacement: rule?.replacement ?? "",
		ordinal: String(rule?.ordinal ?? nextOrdinal),
		enabled: rule?.enabled ?? true,
	};
}

export function TranslationRuleDialog({
	open,
	onOpenChange,
	rulesetId,
	rule,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	rulesetId: string;
	rule: TranslationRuleRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.translationRules;
	const create = usePbxChildCreate(child, "translation-rulesets", rulesetId);
	const update = usePbxChildUpdate(child, "translation-rulesets", rulesetId);
	const mutation = rule === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(rule, nextOrdinal),
		validators: { onSubmit: translationRuleFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = translationRuleFormSchema.parse(value);
			server.clear();
			try {
				if (rule === null) {
					await create.mutateAsync(parsed);
				} else {
					await update.mutateAsync({ id: rule.id, values: parsed });
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
			title={rule === null ? "Add rule" : "Edit rule"}
			description="A regular expression and what to replace the match with. Every enabled rule in the ruleset fires in order, and each one sees the previous one's output."
			submitLabel={rule === null ? "Add rule" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="The pattern is compiled and the replacement is screened when you save, inside the same transaction as the write — a rule that cannot be applied is refused rather than stored and skipped."
		>
			<FormSection title="Rewrite" columns={1}>
				<form.Field name="matchPattern">
					{(field) => (
						<TextField
							field={field}
							label="Match"
							required
							autoFocus={rule === null}
							placeholder="^00(\d+)$"
							description="A regular expression, unanchored unless you anchor it. Capture groups are what the replacement refers to."
							disabled={mutation.isPending}
							submitError={server.errors.matchPattern}
						/>
					)}
				</form.Field>
				<form.Field name="replacement">
					{(field) => (
						<TextField
							field={field}
							label="Replace with"
							placeholder="+$1"
							description="Digits, +, * and # only, plus $1–$9 for capture groups. Leave it empty to strip the match — that is how a strip rule is written."
							disabled={mutation.isPending}
							submitError={server.errors.replacement}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Placement">
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Order"
							required
							description="Lower runs first. Use the Move up and Move down actions on the list rather than editing this by hand — the list rewrites the whole order in one request, which is what the server accepts."
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Strip the international prefix"
							description="What this step is for, in words. It is the only thing on the list that will make sense in six months."
							disabled={mutation.isPending}
							submitError={server.errors.label}
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
							description="A disabled rule is skipped and the next one sees the number unchanged. It keeps its place in the order."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
