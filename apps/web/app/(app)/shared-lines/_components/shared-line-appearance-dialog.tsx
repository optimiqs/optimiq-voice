"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { getFieldErrorMessage } from "~/lib/forms/field-errors";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import {
	sharedLineAppearanceFormSchema,
	type SharedLineAppearanceFormValues,
} from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { SharedLineAppearanceRow } from "~/lib/pbx/contracts";

/**
 * One appearance on a shared line — one extension's button.
 *
 * ## Why this is an extension picker and not a destination picker
 *
 * A ring-group member carries a destination trio, which is what lets a group ring a mobile over a
 * trunk. An appearance carries an `extension_id` and nothing else, because the engine ORIGINATES a
 * leg to a registered endpoint and the credential path tells that device which button to light: an
 * external number cannot be told to pick up, and it has no lamp. So the control here is a list of
 * extensions, and the foreign key is what enforces that an appearance resolves to a real endpoint
 * rather than to a name somebody typed. The picker is REQUIRED — a blank appearance lights nobody's
 * button.
 *
 * ## The order is the BUTTON INDEX, which is why it is editable
 *
 * The ordinal here is more than a fan-out order: it is the appearance index the phone lights and the
 * number sipd stamps into the `Call-Info` header. Reordering the appearances renumbers the buttons,
 * so it is the operator's decision. This box sets it directly for the case where somebody knows the
 * position they want; the line's page has Move up / Move down for the ordinary case, which go through
 * `PUT …/appearances/reorder` and rewrite the whole order in one transaction.
 *
 * `(line, ordinal)` is UNIQUE, so two appearances cannot claim the same button — a collision here
 * comes back as a `PBX_CONFLICT` attached to this field rather than as a silent reshuffle. `(line,
 * extension)` is unique too, so one desk cannot hold two buttons on the same line.
 */
function defaultsFor(
	appearance: SharedLineAppearanceRow | null,
	nextOrdinal: number,
): SharedLineAppearanceFormValues {
	return {
		extensionId: appearance?.extensionId ?? "",
		ordinal: appearance === null ? String(nextOrdinal) : String(appearance.ordinal),
		enabled: appearance?.enabled ?? true,
	};
}

export function SharedLineAppearanceDialog({
	open,
	onOpenChange,
	lineId,
	appearance,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	lineId: string;
	appearance: SharedLineAppearanceRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.sharedLineAppearances;
	const create = usePbxChildCreate(child, "shared-lines", lineId);
	const update = usePbxChildUpdate(child, "shared-lines", lineId);
	const mutation = appearance === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(appearance, nextOrdinal),
		validators: { onSubmit: sharedLineAppearanceFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = sharedLineAppearanceFormSchema.parse(value);
			server.clear();

			/**
			 * `ordinal` is REQUIRED by the create DTO — it is not `resettable`, because there is no
			 * server default for "which button". The box is pre-filled with the next free position, so
			 * the `?? 0` is only reached by somebody who cleared it on purpose.
			 */
			const body = {
				extensionId: parsed.extensionId,
				ordinal: parsed.ordinal ?? 0,
				enabled: parsed.enabled,
			};

			try {
				if (appearance === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: appearance.id, values: body });
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
			title={appearance === null ? "Add appearance" : "Edit appearance"}
			description="Which handset lights a button for this line, and which button position it sits on."
			submitLabel={appearance === null ? "Add appearance" : "Save appearance"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<FormSection title="Handset">
				<form.Field name="extensionId">
					{(field) => (
						<ResourceSelect
							id="sharedLineAppearanceExtensionId"
							label="Extension"
							resource={PBX_RESOURCES.extensions}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							allowEmpty={false}
							placeholder="Choose an extension…"
							description="Only extensions, because the engine lights a button on a registered handset — an external number has no lamp and cannot be given an appearance."
							disabled={mutation.isPending}
							/**
							 * `ResourceSelect` is not a `FieldLike` adapter, so it does not resolve its own
							 * error the way `TextField` does. The client validator comes first here: "Required"
							 * belongs on the control before the request is made, not after the server answers.
							 */
							error={getFieldErrorMessage(field.state.meta.errors) ?? server.errors.extensionId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Button position"
							placeholder="0"
							description="The appearance index the phone lights and stamps into Call-Info. Two appearances cannot share a position — use Move up and Move down on the line's page to renumber the whole list at once."
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled appearance stays in the list and its button does not light for this line."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
