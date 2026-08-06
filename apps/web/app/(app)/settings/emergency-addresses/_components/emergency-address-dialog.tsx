"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import {
	emergencyAddressFormSchema,
	type EmergencyAddressFormValues,
} from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../../_hooks/use-pbx-queries";
import type { EmergencyAddressRow } from "~/lib/pbx/contracts";

/**
 * A dispatchable location, as far as this platform can express one.
 *
 * ## Why the validation here is so thin
 *
 * The form checks that the required lines are present, that the country is two letters, and
 * nothing else. That is the schema's deliberate position and it is worth restating on the screen
 * that uses it: the authority on whether an address exists is the carrier's E911 API querying the
 * authoritative database, and a second, weaker validator in a browser would refuse addresses that
 * are real — for a building somebody may one day dial 911 from. A false negative here is a worse
 * outcome than a stored address the carrier later rejects.
 *
 * ## Why there is no "validated" control
 *
 * `validated`, `validatedAt`, `validationProvider` and `validationReference` are absent from this
 * form and from the request body, and the API refuses them. They are facts a PROVIDER asserted.
 * Offering a switch would let anyone holding `numbers.emergency` mark an unverified address as
 * verified, and for a field whose entire purpose is regulatory assurance that is not a validation
 * bug, it is a compliance one.
 *
 * ## Why `locationDetail` is optional and still called out
 *
 * RAY BAUM'S Act is about the FLOOR, not the street: a responder given a twelve-storey office block
 * and no suite number is the failure the rule was written for. It is optional because a
 * single-occupancy address genuinely has none, and because a required field would be filled with
 * "n/a". The description says what it is for instead.
 */
function defaultsFor(address: EmergencyAddressRow | null): EmergencyAddressFormValues {
	return {
		label: address?.label ?? "",
		streetLine1: address?.streetLine1 ?? "",
		streetLine2: address?.streetLine2 ?? "",
		locationDetail: address?.locationDetail ?? "",
		locality: address?.locality ?? "",
		administrativeArea: address?.administrativeArea ?? "",
		postalCode: address?.postalCode ?? "",
		country: address?.country ?? "US",
	};
}

export function EmergencyAddressDialog({
	open,
	onOpenChange,
	address,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly address: EmergencyAddressRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.emergencyAddresses);
	const update = usePbxUpdate(PBX_RESOURCES.emergencyAddresses);
	const mutation = address === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(address),
		validators: { onSubmit: emergencyAddressFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = emergencyAddressFormSchema.parse(value);
			server.clear();

			const body = {
				label: parsed.label,
				streetLine1: parsed.streetLine1,
				streetLine2: parsed.streetLine2,
				locationDetail: parsed.locationDetail,
				locality: parsed.locality,
				administrativeArea: parsed.administrativeArea,
				postalCode: parsed.postalCode,
				country: parsed.country,
			};

			try {
				if (address === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: address.id, values: body });
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
			title={address === null ? "New emergency address" : `Edit ${address.label}`}
			description="Where a 911 call from a number assigned to this address should send responders."
			submitLabel={address === null ? "Add address" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Saving stores the address. It does not validate it: nothing in this platform talks to a carrier's E911 provisioning API yet, so every address here stays marked as not validated."
		>
			<FormSection title="Label">
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Label"
							required
							autoFocus={address === null}
							placeholder="Head office, 4th floor"
							description="What this location is called when a number is assigned to it."
							disabled={mutation.isPending}
							submitError={server.errors.label}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Address">
				<form.Field name="streetLine1">
					{(field) => (
						<TextField
							field={field}
							label="Street"
							required
							placeholder="1600 Amphitheatre Parkway"
							disabled={mutation.isPending}
							submitError={server.errors.streetLine1}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="streetLine2">
					{(field) => (
						<TextField
							field={field}
							label="Street, second line"
							placeholder="Building C"
							disabled={mutation.isPending}
							submitError={server.errors.streetLine2}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="locationDetail">
					{(field) => (
						<TextField
							field={field}
							label="Floor, suite or room"
							placeholder="Floor 4, room 412"
							description="Strongly recommended. This is the part RAY BAUM'S Act is about — a street address alone does not tell a responder where in a large building to go."
							disabled={mutation.isPending}
							submitError={server.errors.locationDetail}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="locality">
					{(field) => (
						<TextField
							field={field}
							label="City"
							required
							placeholder="Mountain View"
							disabled={mutation.isPending}
							submitError={server.errors.locality}
						/>
					)}
				</form.Field>
				<form.Field name="administrativeArea">
					{(field) => (
						<TextField
							field={field}
							label="State or province"
							required
							placeholder="CA"
							disabled={mutation.isPending}
							submitError={server.errors.administrativeArea}
						/>
					)}
				</form.Field>
				<form.Field name="postalCode">
					{(field) => (
						<TextField
							field={field}
							label="Postal code"
							required
							placeholder="94043"
							disabled={mutation.isPending}
							submitError={server.errors.postalCode}
						/>
					)}
				</form.Field>
				<form.Field name="country">
					{(field) => (
						<TextField
							field={field}
							label="Country"
							required
							placeholder="US"
							description="Two letters, ISO 3166-1."
							disabled={mutation.isPending}
							submitError={server.errors.country}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
