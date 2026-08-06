"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { RECORD_POLICIES, TOLL_CLASSES } from "~/lib/pbx/contracts";
import { extensionFormSchema, type ExtensionFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { ExtensionRow } from "~/lib/pbx/contracts";

/**
 * Create and edit an extension.
 *
 * ## The SIP secret is a reference, not a password
 *
 * `sipSecretRef` is a handle into the secret manager — the password itself never reaches this
 * database, which is why the field is a plain text input labelled as a reference rather than a
 * masked password box. Rendering it as a password field would tell the user they are typing a
 * credential, and they would.
 *
 * ## Toll class is not a formality
 *
 * An extension may only take an outbound route whose class its own class covers. `national` is
 * the server's default and stays the default here: quietly granting `international` to every new
 * extension is how a compromised endpoint becomes an expensive weekend.
 */

const TOLL_CLASS_LABELS: Readonly<Record<(typeof TOLL_CLASSES)[number], string>> = {
	internal: "Internal only",
	local: "Local",
	national: "National",
	international: "International",
	premium: "Premium rate",
};

const RECORD_POLICY_LABELS: Readonly<Record<(typeof RECORD_POLICIES)[number], string>> = {
	none: "Never record",
	inbound: "Inbound calls",
	outbound: "Outbound calls",
	all: "All calls",
	"on-demand": "On demand only",
};

function defaultsFor(extension: ExtensionRow | null): ExtensionFormValues {
	return {
		number: extension?.number ?? "",
		label: extension?.label ?? "",
		sipSecretRef: extension?.sipSecretRef ?? "",
		callerIdName: extension?.callerIdName ?? "",
		callerIdNumber: extension?.callerIdNumber ?? "",
		outboundCallerIdNumber: extension?.outboundCallerIdNumber ?? "",
		tollClass: extension?.tollClass ?? "national",
		recordPolicy: extension?.recordPolicy ?? "none",
		callTimeoutSeconds:
			extension?.callTimeoutSeconds === undefined ? "" : String(extension.callTimeoutSeconds),
		maxRegistrations:
			extension?.maxRegistrations === undefined ? "" : String(extension.maxRegistrations),
		voicemailEnabled: extension?.voicemailEnabled ?? true,
		doNotDisturb: extension?.doNotDisturb ?? false,
		enabled: extension?.enabled ?? true,
	};
}

export function ExtensionDialog({
	open,
	onOpenChange,
	extension,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** `null` creates; a row edits it. */
	extension: ExtensionRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.extensions);
	const update = usePbxUpdate(PBX_RESOURCES.extensions);
	const mutation = extension === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(extension),
		validators: { onSubmit: extensionFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = extensionFormSchema.parse(value);
			server.clear();

			/**
			 * `undefined` for the optional numbers, never `null`.
			 *
			 * `callTimeoutSeconds` and `maxRegistrations` are `.optional()` on the server, not
			 * `.nullish()` — a null is a 400. `JSON.stringify` drops undefined keys, and an absent key
			 * on a PATCH means "leave it alone", which is exactly what a blank optional field means.
			 */
			const body = {
				number: parsed.number,
				label: parsed.label,
				sipSecretRef: parsed.sipSecretRef,
				callerIdName: parsed.callerIdName,
				callerIdNumber: parsed.callerIdNumber,
				outboundCallerIdNumber: parsed.outboundCallerIdNumber,
				tollClass: parsed.tollClass,
				recordPolicy: parsed.recordPolicy,
				callTimeoutSeconds: parsed.callTimeoutSeconds ?? undefined,
				maxRegistrations: parsed.maxRegistrations ?? undefined,
				voicemailEnabled: parsed.voicemailEnabled,
				doNotDisturb: parsed.doNotDisturb,
				enabled: parsed.enabled,
			};

			try {
				if (extension === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: extension.id, values: body });
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
					// Reset on CLOSE, not on open: a dialog that clears itself as it fades out looks
					// finished, whereas clearing on open flashes the previous row's values first.
					server.clear();
					mutation.reset();
					form.reset();
				}
				onOpenChange(next);
			}}
			title={extension === null ? "New extension" : `Edit ${extension.number}`}
			description="An internal endpoint: what it dials as, what it may dial, and what happens when nobody answers."
			submitLabel={extension === null ? "Create extension" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
		>
			<FormSection title="Identity">
				<form.Field name="number">
					{(field) => (
						<TextField
							field={field}
							label="Extension number"
							required
							autoFocus={extension === null}
							placeholder="1001"
							disabled={mutation.isPending}
							submitError={server.errors.number}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							placeholder="Alice Nguyen"
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="sipSecretRef">
					{(field) => (
						<TextField
							field={field}
							label="SIP secret reference"
							required
							placeholder="secret://extensions/1001"
							description="A handle into the secret manager. The password itself is never stored here."
							disabled={mutation.isPending}
							submitError={server.errors.sipSecretRef}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Caller ID">
				<form.Field name="callerIdName">
					{(field) => (
						<TextField
							field={field}
							label="Internal name"
							placeholder="Alice Nguyen"
							disabled={mutation.isPending}
							submitError={server.errors.callerIdName}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="1001"
							disabled={mutation.isPending}
							submitError={server.errors.callerIdNumber}
						/>
					)}
				</form.Field>
				<form.Field name="outboundCallerIdNumber">
					{(field) => (
						<TextField
							field={field}
							label="Outbound number"
							placeholder="+12125550100"
							description="What the outside world sees. Blank uses the trunk's own caller ID."
							disabled={mutation.isPending}
							submitError={server.errors.outboundCallerIdNumber}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Calling and recording">
				<form.Field name="tollClass">
					{(field) => (
						<SelectField
							field={field}
							label="Toll class"
							required
							description="This extension may only take outbound routes at or below this class."
							disabled={mutation.isPending}
							submitError={server.errors.tollClass}
						>
							{TOLL_CLASSES.map((value) => (
								<option key={value} value={value}>
									{TOLL_CLASS_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="recordPolicy">
					{(field) => (
						<SelectField
							field={field}
							label="Recording"
							disabled={mutation.isPending}
							submitError={server.errors.recordPolicy}
						>
							{RECORD_POLICIES.map((value) => (
								<option key={value} value={value}>
									{RECORD_POLICY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="callTimeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Ring for (seconds)"
							placeholder="30"
							description="Blank keeps the system default."
							disabled={mutation.isPending}
							submitError={server.errors.callTimeoutSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="maxRegistrations">
					{(field) => (
						<TextField
							field={field}
							label="Max registered devices"
							placeholder="3"
							disabled={mutation.isPending}
							submitError={server.errors.maxRegistrations}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="voicemailEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Voicemail"
							description="Unanswered calls go to this extension's mailbox."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="doNotDisturb">
					{(field) => (
						<SwitchField
							field={field}
							label="Do not disturb"
							description="Calls skip this extension entirely."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled extension cannot register and is skipped by every route."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
