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
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { RequirePermission } from "../../_components/require-permission";
import {
	useNotificationSettings,
	useSaveNotificationSettings,
} from "../../_hooks/use-org-settings-queries";
import { SettingsNav } from "../_components/settings-nav";

/**
 * The `notifications` category of the settings cascade.
 *
 * ## One card, five settings, and the two switches that are not both here
 *
 * `voicemailToEmailEnabled` is the ORGANIZATION's policy. Each mailbox also carries its own
 * delivery mode (`None` / `Notify` / `Attach`) on the voicemail screen, and both must be on for a
 * message to go out — the org switch can only ever narrow. The copy below says so, because a
 * setting that silently does nothing for a mailbox set to `None` is a support ticket.
 *
 * ## Why the values are seeded from an effect
 *
 * The category query resolves after the first render, so `defaultValues` cannot carry the tenant's
 * values — the same reason `settings/page.tsx` seeds the organization name from an effect. Binding
 * a switch to `undefined` in the meantime would make it an uncontrolled input that React then
 * complains about the moment the data arrives.
 *
 * ## Save sends the whole form, and that is fine
 *
 * `PATCH …/categories/notifications` is a partial upsert, so sending all five keys writes all five
 * — which is what a form with five controls means by "Save changes". The partial semantics exist
 * for a caller that owns one setting, not to make this screen diff its own state.
 */

const notificationSettingsSchema = z.object({
	voicemailToEmailEnabled: z.boolean(),
	voicemailToEmailIncludeLink: z.boolean(),
	voicemailToEmailIncludeTranscription: z.boolean(),
	fromName: z.string().trim().max(128),
	// Validated as an address only when it is non-empty: empty means "use the platform default",
	// which the API expresses as `null`.
	replyTo: z
		.string()
		.refine((value) => value === "" || z.email().max(254).safeParse(value).success, {
			message: "Enter an email address, or leave it empty to use the platform default",
		}),
});

type NotificationSettingsForm = z.infer<typeof notificationSettingsSchema>;

const EMPTY_FORM: NotificationSettingsForm = {
	voicemailToEmailEnabled: true,
	voicemailToEmailIncludeLink: true,
	voicemailToEmailIncludeTranscription: true,
	fromName: "",
	replyTo: "",
};

export default function NotificationSettingsPage() {
	const settings = useNotificationSettings();
	const save = useSaveNotificationSettings();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: notificationSettingsSchema },
		onSubmit: async ({ value }) => {
			const parsed = notificationSettingsSchema.parse(value);
			await save.mutateAsync({
				voicemailToEmailEnabled: parsed.voicemailToEmailEnabled,
				voicemailToEmailIncludeLink: parsed.voicemailToEmailIncludeLink,
				voicemailToEmailIncludeTranscription: parsed.voicemailToEmailIncludeTranscription,
				// The cascade stores "unset" as `null`, never as an empty string: an empty string is a
				// value, and a from-name of "" would render as a message from nobody.
				fromName: parsed.fromName.length === 0 ? null : parsed.fromName,
				replyTo: parsed.replyTo.length === 0 ? null : parsed.replyTo,
			});
		},
	});

	const loaded = settings.data;
	useEffect(() => {
		if (loaded) {
			form.reset({
				voicemailToEmailEnabled: loaded.voicemailToEmailEnabled,
				voicemailToEmailIncludeLink: loaded.voicemailToEmailIncludeLink,
				voicemailToEmailIncludeTranscription: loaded.voicemailToEmailIncludeTranscription,
				fromName: loaded.fromName ?? "",
				replyTo: loaded.replyTo ?? "",
			});
		}
	}, [loaded, form]);

	return (
		<>
			<PageHeader
				title="Notifications"
				description="What this organization sends by email, and who it appears to come from."
			/>
			<SettingsNav />

			{settings.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading notification settings" />
					</CardBody>
				</Card>
			) : (
				<RequirePermission
					permissions={["settings.write"]}
					fallback={
						<Card>
							<CardHeader>
								<CardTitle>Notifications</CardTitle>
								<CardDescription>
									Your role can view these settings but not change them.
								</CardDescription>
							</CardHeader>
							<CardBody className="space-y-2 text-sm text-foreground">
								<p>
									Voicemail to email is {loaded?.voicemailToEmailEnabled ? "on" : "off"} for this
									organization.
								</p>
								<p className="text-muted-foreground">
									From name: {loaded?.fromName ?? "the platform default"}
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
								<CardTitle>Voicemail to email</CardTitle>
								<CardDescription>
									Each mailbox also has its own delivery mode. Both must be on for a message to be
									sent — turning this off stops every mailbox in the organization.
								</CardDescription>
							</CardHeader>
							<CardBody className="space-y-5">
								<form.Field name="voicemailToEmailEnabled">
									{(field) => (
										<SwitchField
											field={field}
											label="Send an email when a caller leaves a voicemail"
											description="A mailbox whose delivery mode is None is never emailed regardless of this setting."
											disabled={save.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="voicemailToEmailIncludeLink">
									{(field) => (
										<SwitchField
											field={field}
											label="Include a playback link"
											description="A signed link that expires. The recording itself is never attached, so it stays revocable."
											disabled={save.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="voicemailToEmailIncludeTranscription">
									{(field) => (
										<SwitchField
											field={field}
											label="Include the transcription"
											description="Only for mailboxes that have transcription enabled and where one is available."
											disabled={save.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="fromName">
									{(field) => (
										<TextField
											field={field}
											label="From name"
											description="Shown as the sender on notifications. The address itself is deployment configuration."
											placeholder="Optimiq Voice"
											disabled={save.isPending}
											className="max-w-md"
										/>
									)}
								</form.Field>

								<form.Field name="replyTo">
									{(field) => (
										<TextField
											field={field}
											label="Reply-to address"
											type="email"
											description="Where a reply goes. Leave empty to use the platform default."
											disabled={save.isPending}
											className="max-w-md"
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
			)}
		</>
	);
}
