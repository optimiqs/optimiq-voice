"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { FEATURE_CODE_ACTIONS } from "~/lib/pbx/contracts";
import { featureCodeFormSchema, type FeatureCodeFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { FeatureCodeRow } from "~/lib/pbx/contracts";

/**
 * A star code — `*97` to check voicemail, `*69` to redial.
 *
 * `params` is deliberately not editable here. Only a few actions take one (`call-park` wants a
 * `lotId`), the lots it would reference have no management screen yet, and a free-form JSON box
 * on a form used for `*97` would be a trap. Existing params are preserved because the form sends
 * only the keys it shows, which is what `PATCH` semantics are for.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
	"voicemail-check": "Check my voicemail",
	"voicemail-direct": "Leave a voicemail directly",
	"voicemail-record-greeting": "Record a voicemail greeting",
	"call-park": "Park a call",
	"call-pickup": "Pick up a ringing call",
	"group-pickup": "Pick up a call in my group",
	"call-forward-all": "Forward all calls",
	"call-forward-busy": "Forward when busy",
	"call-forward-no-answer": "Forward when unanswered",
	"do-not-disturb": "Do not disturb",
	"follow-me": "Follow me",
	intercom: "Intercom",
	paging: "Page a group",
	"record-toggle": "Start or stop recording",
	redial: "Redial",
	"echo-test": "Echo test",
	"queue-toggle": "Join or leave a queue",
	"agent-status": "Set agent status",
	eavesdrop: "Listen in on a call",
	transfer: "Transfer",
};

function defaultsFor(code: FeatureCodeRow | null): FeatureCodeFormValues {
	return {
		code: code?.code ?? "",
		action: code?.action ?? "voicemail-check",
		label: code?.label ?? "",
		enabled: code?.enabled ?? true,
	};
}

export function FeatureCodeDialog({
	open,
	onOpenChange,
	code,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	code: FeatureCodeRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.featureCodes);
	const update = usePbxUpdate(PBX_RESOURCES.featureCodes);
	const mutation = code === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(code),
		validators: { onSubmit: featureCodeFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = featureCodeFormSchema.parse(value);
			server.clear();

			const body = {
				code: parsed.code,
				action: parsed.action,
				label: parsed.label,
				enabled: parsed.enabled,
			};

			try {
				if (code === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: code.id, values: body });
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
			title={code === null ? "New feature code" : `Edit ${code.code}`}
			description="A star code staff dial from a handset to reach a feature."
			submitLabel={code === null ? "Create code" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<FormSection title="Code">
				<form.Field name="code">
					{(field) => (
						<TextField
							field={field}
							label="Dialled code"
							required
							autoFocus={code === null}
							placeholder="*97"
							description="Starts with * and contains only digits, * or #."
							disabled={mutation.isPending}
							submitError={server.errors.code}
						/>
					)}
				</form.Field>
				<form.Field name="action">
					{(field) => (
						<SelectField
							field={field}
							label="Does"
							required
							disabled={mutation.isPending}
							submitError={server.errors.action}
						>
							{FEATURE_CODE_ACTIONS.map((value) => (
								<option key={value} value={value}>
									{ACTION_LABELS[value] ?? value}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Check voicemail"
							disabled={mutation.isPending}
							submitError={server.errors.label}
							className="sm:col-span-2"
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
							description="A disabled code is not dialable; the digits fall through to normal routing."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
