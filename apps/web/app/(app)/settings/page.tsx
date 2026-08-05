"use client";

import { useForm } from "@tanstack/react-form";
import { useEffect } from "react";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardBody,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import {
	defaultOrganizationNameValues,
	organizationNameSchema,
} from "../_components/create-organization-dialog";
import { RequirePermission } from "../_components/require-permission";
import { useAppSession } from "../_context/session-context";
import { useRenameOrganization } from "../_hooks/use-organization-queries";
import { SettingsNav } from "./_components/settings-nav";

/**
 * Organization settings.
 *
 * Renaming is all this owns today. The three-level settings cascade from the master plan §4.1
 * (platform default → organization → user) is a P3 surface and will land as additional cards here
 * rather than as a separate area, so the mental model stays "one page per scope".
 */
export default function OrganizationSettingsPage() {
	const session = useAppSession();
	const organization = session.activeOrganization;
	const rename = useRenameOrganization(organization?.id);

	const form = useForm({
		defaultValues: defaultOrganizationNameValues,
		validators: { onChange: organizationNameSchema, onSubmit: organizationNameSchema },
		onSubmit: async ({ value }) => {
			await rename.mutateAsync(organizationNameSchema.parse(value).name);
		},
	});

	/**
	 * The session query resolves after the first render, so the form is seeded from the effect
	 * rather than from `defaultValues` — otherwise the field is permanently empty for anyone who
	 * lands here directly.
	 */
	useEffect(() => {
		if (organization) {
			form.reset({ name: organization.name });
		}
	}, [organization, form]);

	return (
		<>
			<PageHeader
				title="Settings"
				description="How this organization is identified across the phone system."
			/>
			<SettingsNav />

			<RequirePermission
				permissions={["settings.write"]}
				fallback={
					<Card>
						<CardHeader>
							<CardTitle>Organization</CardTitle>
							<CardDescription>
								Your role can view these settings but not change them.
							</CardDescription>
						</CardHeader>
						<CardBody className="text-sm text-foreground">{organization?.name}</CardBody>
					</Card>
				}
			>
				<Card>
					<form
						noValidate
						onSubmit={(event) => {
							event.preventDefault();
							void form.handleSubmit();
						}}
					>
						<CardHeader>
							<CardTitle>Organization name</CardTitle>
							<CardDescription>
								Shown in the switcher, on invitations and on outbound notifications. The URL slug is
								not changed by a rename.
							</CardDescription>
						</CardHeader>
						<CardBody>
							<form.Field name="name">
								{(field) => (
									<TextField
										field={field}
										label="Name"
										required
										disabled={rename.isPending}
										className="max-w-md"
									/>
								)}
							</form.Field>
						</CardBody>
						<CardFooter>
							<Button type="submit" variant="primary" loading={rename.isPending}>
								Save changes
							</Button>
						</CardFooter>
					</form>
				</Card>
			</RequirePermission>
		</>
	);
}
