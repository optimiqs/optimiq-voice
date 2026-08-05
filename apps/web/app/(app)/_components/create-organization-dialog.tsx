"use client";

import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { TextField } from "~/components/ui/form-fields";
import { FormFooter } from "~/components/ui/form-footer";
import { slugify, useCreateOrganization } from "../_hooks/use-organization-queries";

export const organizationNameSchema = z.strictObject({
	name: z.string().trim().min(2, "Use at least 2 characters").max(80, "Use at most 80 characters"),
});

export type OrganizationNameValues = z.input<typeof organizationNameSchema>;

export const defaultOrganizationNameValues: OrganizationNameValues = { name: "" };

export function CreateOrganizationDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const createOrganization = useCreateOrganization();

	const form = useForm({
		defaultValues: defaultOrganizationNameValues,
		validators: { onChange: organizationNameSchema, onSubmit: organizationNameSchema },
		onSubmit: async ({ value }) => {
			const parsed = organizationNameSchema.parse(value);
			await createOrganization.mutateAsync(parsed.name);
			form.reset();
			onOpenChange(false);
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>New organization</DialogTitle>
						<DialogDescription>
							An organization is a tenant: its extensions, numbers, routing and call history are
							isolated from every other one. You will be its owner.
						</DialogDescription>
					</DialogHeader>

					<form.Field name="name">
						{(field) => (
							<TextField
								field={field}
								label="Organization name"
								required
								autoFocus
								disabled={createOrganization.isPending}
								description={
									field.state.value.trim().length > 0
										? `URL slug: ${slugify(field.state.value)}`
										: "The URL slug is derived from the name."
								}
							/>
						)}
					</form.Field>

					<DialogFooter>
						<FormFooter
							onCancel={() => onOpenChange(false)}
							submitLabel="Create organization"
							loadingLabel="Creating"
							loading={createOrganization.isPending}
						/>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
