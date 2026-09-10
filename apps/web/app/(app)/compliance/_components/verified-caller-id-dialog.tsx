"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import {
	CALLER_ID_VERIFICATION_METHODS,
	type CallerIdVerificationMethod,
	type VerifiedCallerIdRow,
} from "~/lib/pbx/contracts";
import { verifiedCallerIdFormSchema, type VerifiedCallerIdFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";

/**
 * A number this organization may present as caller ID without owning it.
 *
 * The method and the reference are the form's whole reason for existing. A row with neither is a
 * claim; a row with "carrier-loa" and a reference is evidence somebody can produce when a carrier
 * asks — and it is the difference between an outbound call this platform will attest `B` and one it
 * will only attest `C`.
 */
const METHOD_LABELS: Readonly<Record<CallerIdVerificationMethod, string>> = {
	document: "Document on file (LOA, bill)",
	"call-back": "Call-back code confirmed",
	"carrier-loa": "Carrier authorisation",
};

function isoDateInput(value: string | null): string {
	// Sliced rather than parsed: the stored value is an instant, and `new Date()` here would shift
	// the calendar day for anybody west of UTC — which on an expiry is a day of attestation.
	return value === null ? "" : value.slice(0, 10);
}

function defaultsFor(row: VerifiedCallerIdRow | null): VerifiedCallerIdFormValues {
	return {
		e164: row?.e164 ?? "",
		label: row?.label ?? "",
		verificationMethod: row?.verificationMethod ?? "document",
		verificationReference: row?.verificationReference ?? "",
		verifiedAt: isoDateInput(row?.verifiedAt ?? null),
		expiresAt: isoDateInput(row?.expiresAt ?? null),
		notes: row?.notes ?? "",
	};
}

export function VerifiedCallerIdDialog({
	open,
	onOpenChange,
	callerId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	callerId: VerifiedCallerIdRow | null;
}) {
	const resource = PBX_RESOURCES.verifiedCallerIds;
	const create = usePbxCreate(resource);
	const update = usePbxUpdate(resource);
	const mutation = callerId === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(callerId),
		validators: { onSubmit: verifiedCallerIdFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = verifiedCallerIdFormSchema.parse(value);
			server.clear();
			try {
				if (callerId === null) {
					await create.mutateAsync(parsed);
				} else {
					await update.mutateAsync({ id: callerId.id, values: parsed });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	const errors = server.errors;

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
			title={callerId === null ? "New verified caller ID" : `Edit ${callerId.e164}`}
			description="An external number this organization has proved it may present, and the evidence behind that."
			submitLabel={callerId === null ? "Add caller ID" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="An outbound call presenting this number can be attested B while the verification is current. Past its expiry it drops to C."
		>
			<FormSection title="Number">
				<form.Field name="e164">
					{(field) => (
						<TextField
							field={field}
							label="Number"
							required
							autoFocus={callerId === null}
							placeholder="+15551234567"
							disabled={mutation.isPending}
							submitError={errors.e164}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Client main line"
							disabled={mutation.isPending}
							submitError={errors.label}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Verification">
				<form.Field name="verificationMethod">
					{(field) => (
						<SelectField
							field={field}
							label="How it was verified"
							disabled={mutation.isPending}
							submitError={errors.verificationMethod}
						>
							{CALLER_ID_VERIFICATION_METHODS.map((value) => (
								<option key={value} value={value}>
									{METHOD_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="verificationReference">
					{(field) => (
						<TextField
							field={field}
							label="Reference"
							description="The document number, ticket or call-back code that can be produced on request."
							disabled={mutation.isPending}
							submitError={errors.verificationReference}
						/>
					)}
				</form.Field>
				<form.Field name="verifiedAt">
					{(field) => (
						<TextField
							field={field}
							label="Verified on"
							placeholder="2026-01-31"
							description="YYYY-MM-DD."
							disabled={mutation.isPending}
							submitError={errors.verifiedAt}
						/>
					)}
				</form.Field>
				<form.Field name="expiresAt">
					{(field) => (
						<TextField
							field={field}
							label="Expires"
							placeholder="2027-01-31"
							description="YYYY-MM-DD. Leave empty for a verification that does not lapse."
							disabled={mutation.isPending}
							submitError={errors.expiresAt}
						/>
					)}
				</form.Field>
				<form.Field name="notes">
					{(field) => (
						<TextareaField
							field={field}
							label="Notes"
							rows={3}
							disabled={mutation.isPending}
							submitError={errors.notes}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
