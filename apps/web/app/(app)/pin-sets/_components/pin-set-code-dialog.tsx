"use client";

import { useState } from "react";
import { EntityFormDialog } from "~/components/pbx/entity-form-dialog";
import { Field, FieldDescription, FieldLabel, Input } from "~/components/ui/field";
import { pinSchema } from "~/lib/pbx/schemas";
import { useSetPinSetEntryPin } from "../../_hooks/use-pbx-queries";
import type { PinSetEntryRow } from "~/lib/pbx/contracts";

/**
 * Replacing one code's digits.
 *
 * A dialog of its own, over an endpoint of its own (`PUT …/entries/:id/pin`), for exactly the reason
 * a mailbox PIN has one: the value is hashed on the way in and never comes back, so a field on the
 * ordinary edit form would make "did that save?" a question the response cannot answer.
 *
 * The label and the position are deliberately untouched. They are the identity a call detail record
 * carries, so rotating a code leaves every historical "authorised by the night desk" pointing at the
 * same row — which is what makes rotation something an administrator will actually do.
 *
 * There is no confirmation field. Two boxes that must match is the pattern for a secret the user has
 * to remember and type again later, and this is one an administrator is about to read aloud to
 * somebody; the correction for a typo is to set it again, which costs one dialog.
 */
export function PinSetCodeDialog({
	open,
	onOpenChange,
	pinSetId,
	entry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pinSetId: string;
	entry: PinSetEntryRow | null;
}) {
	const setPin = useSetPinSetEntryPin(pinSetId);
	const [pin, setPinValue] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);

	function submit(): void {
		if (!entry) {
			return;
		}
		const checked = pinSchema.safeParse(pin);
		if (!checked.success) {
			setError(checked.error.issues[0]?.message ?? "Enter a code");
			return;
		}
		setError(undefined);
		setPin.mutate(
			{ entryId: entry.id, pin: checked.data },
			{
				onSuccess: () => {
					setPinValue("");
					onOpenChange(false);
				},
			},
		);
	}

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setPinValue("");
					setError(undefined);
					setPin.reset();
				}
				onOpenChange(next);
			}}
			title={entry?.label ? `Replace the code for ${entry.label}` : "Replace this code"}
			description="The new digits take effect on the next call. The old ones cannot be recovered — they were never stored."
			submitLabel="Set code"
			pending={setPin.isPending}
			error={setPin.error}
			onSubmit={submit}
			footerNote="The label and the position are untouched, so past call records still name this code correctly."
		>
			<Field name="newPin">
				<FieldLabel htmlFor="newPin">
					New digits
					<span aria-hidden="true" className="ml-0.5 text-danger">
						*
					</span>
				</FieldLabel>
				<Input
					id="newPin"
					type="password"
					inputMode="numeric"
					autoComplete="off"
					autoFocus
					value={pin}
					onChange={(event) => {
						setPinValue(event.target.value);
						setError(undefined);
					}}
					disabled={setPin.isPending}
					placeholder="4 to 16 digits"
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? "newPin-error" : "newPin-description"}
				/>
				<FieldDescription id="newPin-description">
					Hashed on the way in and never shown again. Avoid a repeated or counting code.
				</FieldDescription>
				{error ? (
					<p id="newPin-error" role="alert" className="text-xs text-danger">
						{error}
					</p>
				) : null}
			</Field>
		</EntityFormDialog>
	);
}
