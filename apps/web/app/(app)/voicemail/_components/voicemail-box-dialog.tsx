"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { VOICEMAIL_EMAIL_MODES } from "~/lib/pbx/contracts";
import { voicemailBoxFormSchema, type VoicemailBoxFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { VoicemailBoxRow } from "~/lib/pbx/contracts";

/**
 * Create and edit a voicemail box.
 *
 * "Deliver and delete" is the setting worth being careful about: the classic email-and-forget
 * configuration keeps no copy, so a box with that on and no email address destroys every message
 * it receives. The server accepts the combination — it is only unsound in context — so the client
 * schema refuses it and says why.
 */
const EMAIL_MODE_LABELS: Readonly<Record<(typeof VOICEMAIL_EMAIL_MODES)[number], string>> = {
	none: "Do not email",
	notify: "Email a notification",
	attach: "Email the recording",
};

function defaultsFor(box: VoicemailBoxRow | null): VoicemailBoxFormValues {
	return {
		mailboxNumber: box?.mailboxNumber ?? "",
		label: box?.label ?? "",
		emailAddress: box?.emailAddress ?? "",
		emailMode: box?.emailMode ?? "none",
		deleteAfterDelivery: box?.deleteAfterDelivery ?? false,
		transcriptionEnabled: box?.transcriptionEnabled ?? false,
		mwiEnabled: box?.mwiEnabled ?? true,
		maxMessages: box?.maxMessages === undefined ? "" : String(box.maxMessages),
		maxMessageSeconds: box?.maxMessageSeconds === undefined ? "" : String(box.maxMessageSeconds),
		enabled: box?.enabled ?? true,
	};
}

export function VoicemailBoxDialog({
	open,
	onOpenChange,
	box,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	box: VoicemailBoxRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.voicemailBoxes);
	const update = usePbxUpdate(PBX_RESOURCES.voicemailBoxes);
	const mutation = box === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(box),
		validators: { onSubmit: voicemailBoxFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = voicemailBoxFormSchema.parse(value);
			server.clear();

			const body = {
				mailboxNumber: parsed.mailboxNumber,
				label: parsed.label,
				emailAddress: parsed.emailAddress,
				emailMode: parsed.emailMode,
				deleteAfterDelivery: parsed.deleteAfterDelivery,
				transcriptionEnabled: parsed.transcriptionEnabled,
				mwiEnabled: parsed.mwiEnabled,
				maxMessages: parsed.maxMessages ?? undefined,
				maxMessageSeconds: parsed.maxMessageSeconds ?? undefined,
				enabled: parsed.enabled,
			};

			try {
				if (box === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: box.id, values: body });
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
			title={box === null ? "New voicemail box" : `Edit mailbox ${box.mailboxNumber}`}
			description="Where unanswered calls leave a message, and what happens to it afterwards."
			submitLabel={box === null ? "Create mailbox" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
		>
			<FormSection title="Mailbox">
				<form.Field name="mailboxNumber">
					{(field) => (
						<TextField
							field={field}
							label="Mailbox number"
							required
							autoFocus={box === null}
							placeholder="1001"
							description="Usually the extension number, but a box may stand alone."
							disabled={mutation.isPending}
							submitError={server.errors.mailboxNumber}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Alice Nguyen"
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Delivery">
				<form.Field name="emailMode">
					{(field) => (
						<SelectField
							field={field}
							label="Email"
							disabled={mutation.isPending}
							submitError={server.errors.emailMode}
						>
							{VOICEMAIL_EMAIL_MODES.map((value) => (
								<option key={value} value={value}>
									{EMAIL_MODE_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="emailAddress">
					{(field) => (
						<TextField
							field={field}
							label="Email address"
							type="email"
							placeholder="alice@example.com"
							disabled={mutation.isPending}
							submitError={server.errors.emailAddress}
						/>
					)}
				</form.Field>
				<form.Field name="deleteAfterDelivery">
					{(field) => (
						<SwitchField
							field={field}
							label="Delete after delivery"
							description="The box keeps no copy once the email is sent. Without an email address, the message is simply lost."
							disabled={mutation.isPending}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Limits">
				<form.Field name="maxMessages">
					{(field) => (
						<TextField
							field={field}
							label="Max messages"
							placeholder="100"
							disabled={mutation.isPending}
							submitError={server.errors.maxMessages}
						/>
					)}
				</form.Field>
				<form.Field name="maxMessageSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Max message length (seconds)"
							placeholder="180"
							disabled={mutation.isPending}
							submitError={server.errors.maxMessageSeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="mwiEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Message waiting indicator"
							description="Lights the lamp on the handset when a message is waiting."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="transcriptionEnabled">
					{(field) => (
						<SwitchField field={field} label="Transcription" disabled={mutation.isPending} />
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled box refuses new messages."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
