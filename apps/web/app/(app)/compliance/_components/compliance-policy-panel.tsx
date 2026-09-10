"use client";

import { useForm } from "@tanstack/react-form";
import { useEffect } from "react";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardBody,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { SelectField, SwitchField } from "~/components/ui/form-fields";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	UNVERIFIED_CALLER_ID_POLICIES,
	type UnverifiedCallerIdPolicy,
} from "~/lib/org-settings/client";
import { RequirePermission } from "../../_components/require-permission";
import {
	useComplianceSettings,
	useSaveComplianceSettings,
} from "../../_hooks/use-org-settings-queries";

/**
 * The `compliance` category of the settings cascade, rendered here rather than under `/settings`.
 *
 * The settings screens in this app are one bespoke page per category — there is no generic
 * catalogue-driven form to add a category to — so this had to be a form somewhere, and it belongs
 * beside the list it governs: the two settings decide what happens to a number that is NOT on the
 * verified caller ID list, which is a sentence that only means something next to the list.
 *
 * ## Read on `compliance.read`, saved on `settings.write`
 *
 * The page's own gate is `compliance.read` and the cascade's is `settings.read`/`settings.write`,
 * so a compliance officer holding no settings grant sees the current policy and cannot change it.
 * That is the API's split, not this screen's: `OrgSettingsController` guards the category, and a
 * screen that hid the panel instead would hide the setting that decides whether their work has any
 * effect.
 *
 * Both keys are sent on every save. `PATCH …/categories/compliance` is a partial upsert, so
 * sending both writes both — which is what a form with two controls means by "Save changes".
 */
const POLICY_LABELS: Readonly<Record<UnverifiedCallerIdPolicy, string>> = {
	allow: "Allow it through unchanged",
	replace: "Replace it with the organization's default number",
	refuse: "Refuse the call",
};

const complianceSettingsSchema = z.object({
	unverifiedCallerIdPolicy: z.enum(UNVERIFIED_CALLER_ID_POLICIES),
	requireKycForOutbound: z.boolean(),
});

type ComplianceSettingsForm = z.infer<typeof complianceSettingsSchema>;

const EMPTY_FORM: ComplianceSettingsForm = {
	unverifiedCallerIdPolicy: "replace",
	requireKycForOutbound: false,
};

export function CompliancePolicyPanel() {
	const settings = useComplianceSettings();
	const save = useSaveComplianceSettings();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: complianceSettingsSchema },
		onSubmit: async ({ value }) => {
			const parsed = complianceSettingsSchema.parse(value);
			await save.mutateAsync({
				unverifiedCallerIdPolicy: parsed.unverifiedCallerIdPolicy,
				requireKycForOutbound: parsed.requireKycForOutbound,
			});
		},
	});

	// The category resolves after the first render, so `defaultValues` cannot carry the tenant's
	// values and a control bound to `undefined` in the meantime is an uncontrolled input. Same
	// reason, same shape, as every other settings screen here.
	const loaded = settings.data;
	useEffect(() => {
		if (loaded) {
			form.reset({
				unverifiedCallerIdPolicy: loaded.unverifiedCallerIdPolicy,
				requireKycForOutbound: loaded.requireKycForOutbound,
			});
		}
	}, [loaded, form]);

	if (settings.isPending) {
		return (
			<Card>
				<CardBody className="p-0">
					<LoadingPanel label="Loading compliance settings" />
				</CardBody>
			</Card>
		);
	}

	return (
		<RequirePermission
			permissions={["settings.write"]}
			fallback={
				<Card>
					<CardHeader>
						<CardTitle>Outbound policy</CardTitle>
						<CardDescription>Your role can view this policy but not change it.</CardDescription>
					</CardHeader>
					<CardBody className="space-y-2 text-sm text-foreground">
						<p>
							An unverified caller ID:{" "}
							{loaded ? POLICY_LABELS[loaded.unverifiedCallerIdPolicy].toLowerCase() : "—"}.
						</p>
						<p className="text-muted-foreground">
							Outbound dialling {loaded?.requireKycForOutbound ? "waits on" : "does not wait on"} an
							approved compliance record.
						</p>
					</CardBody>
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
						<CardTitle>Outbound policy</CardTitle>
						<CardDescription>
							What an outbound call may claim as its caller ID when nothing on this page backs the
							claim up.
						</CardDescription>
					</CardHeader>
					<CardBody className="space-y-5">
						<form.Field name="unverifiedCallerIdPolicy">
							{(field) => (
								<SelectField
									field={field}
									label="A caller ID this organization neither owns nor has verified"
									description="Allowing it through means the call is signed C at best, and a carrier that traces it back finds nothing behind the number."
									disabled={save.isPending}
									className="max-w-xl"
								>
									{UNVERIFIED_CALLER_ID_POLICIES.map((value) => (
										<option key={value} value={value}>
											{POLICY_LABELS[value]}
										</option>
									))}
								</SelectField>
							)}
						</form.Field>

						<form.Field name="requireKycForOutbound">
							{(field) => (
								<SwitchField
									field={field}
									label="Require an approved compliance record before dialling out"
									description="With this on, outbound calls are refused until the record on this page is approved. Emergency calls are never gated by it."
									disabled={save.isPending}
								/>
							)}
						</form.Field>
					</CardBody>
					<CardFooter>
						<Button type="submit" variant="primary" loading={save.isPending}>
							Save changes
						</Button>
					</CardFooter>
				</form>
			</Card>
		</RequirePermission>
	);
}
