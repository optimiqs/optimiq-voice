"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PROVISIONING_RESOURCES } from "~/lib/provisioning/client";
import { DEVICE_VENDORS, VENDOR_LABELS, type DeviceProfileRow } from "~/lib/provisioning/contracts";
import {
	deviceProfileFormSchema,
	settingsToText,
	type DeviceProfileFormValues,
} from "~/lib/provisioning/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";

/**
 * A device profile: the settings a fleet of identical phones shares.
 *
 * ## Why this is a separate entity rather than "copy settings from another device"
 *
 * Because the interesting operation is the SECOND one. Copying gives forty phones the same time
 * zone once; a profile means changing the time zone changes forty phones, which is the whole reason
 * an administrator with forty phones wants anything here at all. It is also why deleting a profile
 * a device still uses is refused rather than silently nulling the link: that delete would strip the
 * settings from every phone that used it, and nothing would report it.
 *
 * `vendor` and `model` on a profile are advisory rather than enforced — the API does not refuse a
 * Yealink device pointed at a Poly profile, because the settings bag is free-form and a deployment
 * may legitimately share cross-vendor parameters. The field's description says so instead of the
 * form pretending to a constraint the server does not have.
 */
function defaultsFor(profile: DeviceProfileRow | null): DeviceProfileFormValues {
	return {
		name: profile?.name ?? "",
		description: profile?.description ?? "",
		vendor: profile?.vendor ?? "yealink",
		model: profile?.model ?? "",
		settings: settingsToText(profile?.settings),
		enabled: profile?.enabled ?? true,
	};
}

export function DeviceProfileDialog({
	open,
	onOpenChange,
	profile,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	profile: DeviceProfileRow | null;
}) {
	const create = usePbxCreate(PROVISIONING_RESOURCES.deviceProfiles);
	const update = usePbxUpdate(PROVISIONING_RESOURCES.deviceProfiles);
	const mutation = profile === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(profile),
		validators: { onSubmit: deviceProfileFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = deviceProfileFormSchema.parse(value);
			server.clear();

			const body = {
				name: parsed.name,
				description: parsed.description,
				vendor: parsed.vendor,
				model: parsed.model,
				settings: parsed.settings,
				enabled: parsed.enabled,
			};

			try {
				if (profile === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: profile.id, values: body });
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
			title={profile === null ? "New device profile" : `Edit ${profile.name}`}
			description="Settings a group of identical phones share."
			submitLabel={profile === null ? "Create profile" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Editing a profile changes every device that uses it, at their next check-in. A profile a device still points at cannot be deleted."
		>
			<FormSection title="Profile">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={profile === null}
							placeholder="Reception desk phones"
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextField
							field={field}
							label="Description"
							placeholder="Ground floor, shared time zone and NTP"
							disabled={mutation.isPending}
							submitError={server.errors.description}
						/>
					)}
				</form.Field>
				<form.Field name="vendor">
					{(field) => (
						<SelectField
							field={field}
							label="Vendor"
							required
							description="Advisory: the server does not refuse a device of another vendor pointed here."
							disabled={mutation.isPending}
							submitError={server.errors.vendor}
						>
							{DEVICE_VENDORS.map((vendor) => (
								<option key={vendor} value={vendor}>
									{VENDOR_LABELS[vendor]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="model">
					{(field) => (
						<TextField
							field={field}
							label="Model"
							placeholder="T54W"
							description="Leave empty to apply to every model of this vendor."
							disabled={mutation.isPending}
							submitError={server.errors.model}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Settings" columns={1}>
				<form.Field name="settings">
					{(field) => (
						<TextareaField
							field={field}
							label="Shared settings"
							rows={8}
							placeholder={"local_time.time_zone = +0\nstatic.network.static_dns_enable = 1"}
							description="One vendor parameter per line, as key = value. A device's own settings override these; the organization's are overridden by these."
							disabled={mutation.isPending}
							submitError={server.errors.settings}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled profile stops contributing settings; devices that use it keep only their own."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
