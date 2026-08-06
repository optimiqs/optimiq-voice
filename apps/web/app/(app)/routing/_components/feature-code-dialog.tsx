"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { FEATURE_CODE_ACTIONS } from "~/lib/pbx/contracts";
import {
	buildParamsBody,
	missingRequiredParam,
	paramFieldsFor,
	readParamValues,
} from "~/lib/pbx/feature-code-params";
import { featureCodeFormSchema, type FeatureCodeFormValues } from "~/lib/pbx/schemas";
import {
	useFeatureCodeParamFields,
	usePbxCreate,
	usePbxUpdate,
} from "../../_hooks/use-pbx-queries";
import type { FeatureCodeAction, FeatureCodeParamField, FeatureCodeRow } from "~/lib/pbx/contracts";

/**
 * A star code — `*97` to check voicemail, `*69` to redial.
 *
 * ## `params` is a control, not a JSON box
 *
 * The column is `jsonb`, and the first thing an admin UI reaches for is a textarea. The server
 * declined to make that necessary: `GET /feature-codes/param-fields` says, per action, exactly which
 * keys are accepted and what each one means, so this form renders the declared control — for
 * `call-park` a park-lot picker — and nothing at all for the nineteen actions that take no
 * parameters.
 *
 * The pair is sent together on every save because the server insists on it: `params` alone has
 * nothing to be validated against, and an `action` sent alone CLEARS the parameters. That is exactly
 * what this form means by switching the action — a `redial` row carrying a `lotId` is configuration
 * nobody wrote and nothing reads.
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
	const declaration = useFeatureCodeParamFields();

	/**
	 * Parameter values live outside the form because WHICH of them exist depends on the action
	 * select, and TanStack Form's field set is declared up front. Keyed by parameter name across
	 * every action: switching action changes which keys are read, and `buildParamsBody` only ever
	 * sends the ones the chosen action declares.
	 */
	const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
		readParamValues(code, paramFieldsFor(declaration.data, code?.action ?? "voicemail-check")),
	);
	const [paramError, setParamError] = useState<string | undefined>(undefined);

	const form = useForm({
		defaultValues: defaultsFor(code),
		validators: { onSubmit: featureCodeFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = featureCodeFormSchema.parse(value);
			server.clear();

			const fields = paramFieldsFor(declaration.data, parsed.action);
			const missing = missingRequiredParam(fields, paramValues);
			if (missing) {
				setParamError(`${missing.label} is required for this action.`);
				return;
			}
			setParamError(undefined);

			const body = {
				code: parsed.code,
				action: parsed.action,
				// Always alongside the action, never without it — see the note above.
				params: buildParamsBody(fields, paramValues),
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
					setParamError(undefined);
					setParamValues(
						readParamValues(
							code,
							paramFieldsFor(declaration.data, code?.action ?? "voicemail-check"),
						),
					);
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

			{/*
			 * Subscribed to the action alone: the parameter controls exist because of it, and
			 * re-rendering the whole dialog on every keystroke in the code field to discover that
			 * would be the same answer computed a hundred times.
			 */}
			<form.Subscribe selector={(state) => state.values.action}>
				{(action) => (
					<ParamsSection
						fields={paramFieldsFor(declaration.data, action as FeatureCodeAction)}
						values={paramValues}
						onChange={(name, value) => {
							setParamValues((previous) => ({ ...previous, [name]: value }));
							setParamError(undefined);
						}}
						disabled={mutation.isPending}
						error={paramError ?? server.errors.params}
					/>
				)}
			</form.Subscribe>

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

/** The declared parameters of the selected action. Absent entirely when it takes none. */
function ParamsSection({
	fields,
	values,
	onChange,
	disabled,
	error,
}: {
	fields: readonly FeatureCodeParamField[];
	values: Readonly<Record<string, string>>;
	onChange: (name: string, value: string) => void;
	disabled: boolean;
	error?: string;
}) {
	if (fields.length === 0) {
		return null;
	}

	return (
		<FormSection
			title="Parameters"
			description="What this action is pointed at. Declared by the server, so only the keys it accepts are offered."
		>
			{fields.map((field) => (
				<ParamControl
					key={field.name}
					field={field}
					value={values[field.name] ?? ""}
					onChange={(value) => onChange(field.name, value)}
					disabled={disabled}
					error={error}
				/>
			))}
		</FormSection>
	);
}

/**
 * One declared parameter.
 *
 * `kind: "entity"` carries the destination type whose list populates the picker, which is the same
 * vocabulary `destinationType` uses — so `park` reuses the park-lot list this app already reads
 * rather than learning a second way to choose a lot. A kind or entity type this build has no control
 * for is stated as such rather than rendered as a text box for a uuid: the server has just told us
 * it expects a row id, and a free-text field would only produce a 422 the user cannot act on.
 */
function ParamControl({
	field,
	value,
	onChange,
	disabled,
	error,
}: {
	field: FeatureCodeParamField;
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
	error?: string;
}) {
	if (field.kind === "entity" && field.entityType === "park") {
		return (
			<ResourceSelect
				id={`params.${field.name}`}
				label={field.label}
				description={field.description}
				resource={PBX_RESOURCES.parkLots}
				value={value}
				onChange={onChange}
				allowEmpty={!field.required}
				emptyLabel="Any lot with a free slot"
				disabled={disabled}
				error={error}
				className="sm:col-span-2"
			/>
		);
	}

	return (
		<p className="text-xs text-muted-foreground sm:col-span-2">
			<span className="font-medium text-foreground">{field.label}</span> — {field.description} This
			build has no control for it, so whatever is stored is left as it is.
		</p>
	);
}
