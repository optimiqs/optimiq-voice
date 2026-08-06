"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { SelectField, SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PROVISIONING_RESOURCES } from "~/lib/provisioning/client";
import {
	DEVICE_VENDORS,
	VENDOR_LABELS,
	formatMacAddress,
	type DeviceRow,
	type DeviceVendor,
} from "~/lib/provisioning/contracts";
import {
	deviceFormSchema,
	settingsToText,
	type DeviceFormValues,
} from "~/lib/provisioning/schemas";
import { usePbxUpdate } from "../../_hooks/use-pbx-queries";
import { useCreateDevice, useProvisioningCatalog } from "../../_hooks/use-provisioning-queries";
import type { ProvisionedDeviceEnvelope } from "~/lib/provisioning/contracts";

/**
 * A device: a MAC address, a vendor, and what it should be configured with.
 *
 * ## The MAC is the identity, and it is normalized on the way in
 *
 * An administrator pastes whatever their label printer chose — `00:15:65:AB:CD:EF`,
 * `0015.65ab.cdef`, `001565ABCDEF` — and all three are the same address. The schema normalizes to
 * the stored form so the uniqueness index is over addresses rather than over spellings, and the
 * field's description says what will be stored. Without that, the same phone could be entered twice
 * and the second entry would silently win the provisioning race.
 *
 * ## The vendor picker shows what has NOT been validated
 *
 * The catalogue endpoint returns each vendor's `caveats`, and they are rendered right here rather
 * than in a document nobody reads. Somebody about to standardize on forty handsets should be able to
 * see "not validated against physical hardware" before they order them, not after.
 */
function defaultsFor(device: DeviceRow | null): DeviceFormValues {
	return {
		macAddress: device ? formatMacAddress(device.macAddress) : "",
		vendor: device?.vendor ?? "yealink",
		model: device?.model ?? "",
		label: device?.label ?? "",
		deviceProfileId: device?.deviceProfileId ?? "",
		settings: settingsToText(device?.settings),
		enabled: device?.enabled ?? true,
	};
}

export function DeviceDialog({
	open,
	onOpenChange,
	device,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	device: DeviceRow | null;
	/** Handed the once-only provisioning URL, so the screen can put it on the page. */
	onCreated?: (result: ProvisionedDeviceEnvelope) => void;
}) {
	const create = useCreateDevice();
	const update = usePbxUpdate(PROVISIONING_RESOURCES.devices);
	const mutation = device === null ? create : update;
	const catalog = useProvisioningCatalog();
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(device),
		validators: { onSubmit: deviceFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = deviceFormSchema.parse(value);
			server.clear();

			const body = {
				macAddress: parsed.macAddress,
				vendor: parsed.vendor,
				model: parsed.model,
				label: parsed.label,
				deviceProfileId: parsed.deviceProfileId,
				settings: parsed.settings,
				enabled: parsed.enabled,
			};

			try {
				if (device === null) {
					const result = await create.mutateAsync(body);
					onCreated?.(result);
				} else {
					await update.mutateAsync({ id: device.id, values: body });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	const selectedVendor = form.state.values.vendor as DeviceVendor;
	const entry = catalog.data?.vendors.find((candidate) => candidate.vendor === selectedVendor);

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
			title={device === null ? "New device" : `Edit ${formatMacAddress(device.macAddress)}`}
			description="A desk phone or softphone, identified by its MAC address."
			submitLabel={device === null ? "Create device" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote={
				device === null
					? "Creating a device mints its provisioning URL. The URL is shown once and cannot be re-read — rotating is the only way to get a new one."
					: "The provisioning URL is not editable here. Rotate it from the device's row to revoke the current one."
			}
		>
			{catalog.data?.configured === false ? (
				<NoticeBanner
					title="This deployment cannot provision phones yet"
					description={
						<>
							Devices can be recorded now, but a phone fetching its configuration will get a 503
							until an operator sets{" "}
							<code className="font-mono text-xs">{catalog.data.missing.join(" and ")}</code> on the
							API.
						</>
					}
				/>
			) : null}

			<FormSection title="Identity">
				<form.Field name="macAddress">
					{(field) => (
						<TextField
							field={field}
							label="MAC address"
							required
							autoFocus={device === null}
							placeholder="00:15:65:AB:CD:EF"
							description="Printed on the bottom of the phone. Any separators work — it is stored as twelve lower-case hex digits."
							disabled={mutation.isPending || device !== null}
							submitError={server.errors.macAddress}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							placeholder="Reception"
							description="What this phone is called when somebody goes looking for it."
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Hardware">
				<form.Field name="vendor">
					{(field) => (
						<SelectField
							field={field}
							label="Vendor"
							required
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
							placeholder={entry?.models[0] ?? "T54W"}
							description={
								entry === undefined || entry.models.length === 0
									? "Whatever is printed on the phone."
									: `Families covered: ${entry.models.join(", ")}. A model not listed still gets this vendor's template.`
							}
							disabled={mutation.isPending}
							submitError={server.errors.model}
						/>
					)}
				</form.Field>
			</FormSection>

			{entry !== undefined && entry.caveats.length > 0 ? (
				<NoticeBanner
					title={
						entry.provisionable
							? `What has not been validated for ${VENDOR_LABELS[selectedVendor]}`
							: "This vendor cannot be provisioned"
					}
					description={
						<ul className="list-disc pl-4">
							{entry.caveats.map((caveat) => (
								<li key={caveat}>{caveat}</li>
							))}
						</ul>
					}
				/>
			) : null}

			<FormSection title="Configuration" columns={1}>
				<form.Field name="deviceProfileId">
					{(field) => (
						<ResourceSelect
							id={field.name}
							label="Profile"
							resource={PROVISIONING_RESOURCES.deviceProfiles}
							value={field.state.value}
							onChange={(value) => field.handleChange(value)}
							emptyLabel="No profile"
							description="A reusable set of keys and settings. Anything set on this device overrides the profile."
							disabled={mutation.isPending}
							error={server.errors.deviceProfileId}
						/>
					)}
				</form.Field>
				<form.Field name="settings">
					{(field) => (
						<TextareaField
							field={field}
							label="Device settings"
							rows={6}
							placeholder={"local_time.time_zone = +0\nfeatures.dnd.enable = 1"}
							description="One vendor parameter per line, as key = value. These win over the profile's and the organization's. Blank lines and # comments are ignored, so a block pasted from a vendor guide works as-is."
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
							description="A disabled device stops receiving configurations. Its phone keeps whatever it last fetched until it is factory reset."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
