"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { Field, FieldDescription, FieldLabel, Input } from "~/components/ui/field";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { pinSchema, pinSetEntryFormSchema, type PinSetEntryFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { PinSetEntryRow } from "~/lib/pbx/contracts";

/**
 * One authorisation code.
 *
 * ## Creating carries the digits; editing cannot
 *
 * The create endpoint takes the metadata and the code in ONE request, and the server is explicit
 * about why: a code with no digest is a row the compiler drops with a warning, so a
 * create-then-set-the-PIN flow would leave a window in which the set looks configured on screen and
 * gates nothing on the wire. So the field is here, required, on create only.
 *
 * On edit it is absent — not disabled, absent. The digest is stripped from every response
 * (`secretColumns` on the server's resource), so there is nothing to pre-fill, and a blank box that
 * silently meant "leave it alone" is the ambiguity that makes people retype secrets they did not
 * mean to change. Replacing a code is a separate action with its own endpoint; see
 * `pin-set-code-dialog.tsx`.
 *
 * ## The ordinal is required
 *
 * It is the identity a call detail record names — "authorised by code 3" — so it is a value an
 * administrator chooses rather than a position a loader returned. The dialog pre-fills the next free
 * one so the requirement is only ever met by somebody who cleared the box on purpose.
 */
function defaultsFor(entry: PinSetEntryRow | null, nextOrdinal: number): PinSetEntryFormValues {
	return {
		label: entry?.label ?? "",
		ordinal: String(entry?.ordinal ?? nextOrdinal),
		enabled: entry?.enabled ?? true,
	};
}

export function PinSetEntryDialog({
	open,
	onOpenChange,
	pinSetId,
	entry,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pinSetId: string;
	entry: PinSetEntryRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.pinSetEntries;
	const create = usePbxChildCreate(child, "pin-sets", pinSetId);
	const update = usePbxChildUpdate(child, "pin-sets", pinSetId);
	const mutation = entry === null ? create : update;
	const server = useServerFieldErrors();

	const [pin, setPin] = useState("");
	const [pinError, setPinError] = useState<string | undefined>(undefined);

	const form = useForm({
		defaultValues: defaultsFor(entry, nextOrdinal),
		validators: { onSubmit: pinSetEntryFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = pinSetEntryFormSchema.parse(value);
			server.clear();

			try {
				if (entry === null) {
					// Held outside the schema for the reason the destination trio is: it is not a column
					// on the row, it is a value the endpoint hashes and discards. A `strictObject` that
					// declared it would invite the edit form to send it too.
					const checked = pinSchema.safeParse(pin);
					if (!checked.success) {
						setPinError(checked.error.issues[0]?.message ?? "Enter a code");
						return;
					}
					setPinError(undefined);
					await create.mutateAsync({ ...parsed, pin: checked.data });
				} else {
					await update.mutateAsync({ id: entry.id, values: parsed });
				}
				form.reset();
				setPin("");
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
					setPin("");
					setPinError(undefined);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={entry === null ? "Add code" : "Edit code"}
			description={
				entry === null
					? "The code and what it is called, together — a code with no digits gates nothing."
					: "What this code is called and where it sits. The digits are replaced from the list's own action."
			}
			submitLabel={entry === null ? "Add code" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="A call record names the label and the position, never the digits. That is the whole of what a plaintext column was ever needed for."
		>
			<FormSection title="Code" columns={1}>
				{entry === null ? (
					<Field name="pin">
						<FieldLabel htmlFor="pin">
							Digits
							<span aria-hidden="true" className="ml-0.5 text-danger">
								*
							</span>
						</FieldLabel>
						<Input
							id="pin"
							type="password"
							inputMode="numeric"
							autoComplete="off"
							value={pin}
							onChange={(event) => {
								setPin(event.target.value);
								setPinError(undefined);
							}}
							disabled={mutation.isPending}
							placeholder="4 to 16 digits"
							aria-invalid={pinError ? true : undefined}
							aria-describedby={pinError ? "pin-error" : "pin-description"}
						/>
						<FieldDescription id="pin-description">
							Hashed on the way in and never shown again. Avoid a repeated or counting code — the
							server will accept one, and three tries per call is enough to find it.
						</FieldDescription>
						{pinError ? (
							<p id="pin-error" role="alert" className="text-xs text-danger">
								{pinError}
							</p>
						) : null}
					</Field>
				) : null}
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							autoFocus={entry !== null}
							placeholder="Night desk"
							description="Who holds this code. It is what a call record will show beside every call the code authorised."
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Position"
							required
							description="Also the code's identity in call records, so changing it re-labels history. Use Move up and Move down on the list instead."
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
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
							description="A disabled code is refused at the prompt. The row and its position stay, so past call records still resolve."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
