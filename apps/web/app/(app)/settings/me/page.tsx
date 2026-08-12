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
import { SwitchField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { RequirePermission } from "../../_components/require-permission";
import { useOwnSettings, useSaveOwnSettings } from "../../_hooks/use-org-settings-queries";
import { SettingsNav } from "../_components/settings-nav";

/**
 * My preferences — the user level of the settings cascade.
 *
 * ## Two switches, and what is deliberately not here
 *
 * The catalogue marks exactly two settings user-scoped today, both in the `notifications` category,
 * and the shape of that decision is what this page has to communicate. Neither of the obvious
 * neighbours is offered:
 *
 * - **"Send me voicemail email at all"** is not here, and its absence is not an oversight. That
 *   answer already lives on the mailbox, as `voicemail_box.email_mode` (`None` / `Notify` /
 *   `Attach`) on the voicemail screen. A second copy here would be a second source of truth, and
 *   the two would disagree the first time somebody changed one through the screen that did not know
 *   about the other.
 * - **The organization's kill switch** is not here either, and it can only ever narrow what these
 *   do. Turning both of these on when the organization has voicemail-to-email off changes nothing,
 *   so the page says so rather than presenting two controls that silently do nothing.
 *
 * ## The values shown are RESOLVED, not "mine"
 *
 * `GET …/me` answers with the whole cascade for this person — code default, overlaid by the
 * organization's row, overlaid by their own. So a switch that reads "on" may be on because the
 * organization set it that way and this person has never touched it, and touching it is what writes
 * the override that makes it theirs. That is the right thing to bind to: the control shows what is
 * in force for them, which is the only question they are asking.
 *
 * ## Whose row is written is not a parameter
 *
 * The server writes `userId: session.user.id` and takes no user id from anywhere — there is no
 * field to send and no row that can belong to somebody else. `settings.write.own` on the route is a
 * floor rather than the whole rule; own-ness is structural.
 *
 * ## This is the one page under /settings a self-service user can open
 *
 * `settings.read.own` is held by roles that hold no `settings.read` at all, and `hasPermission`
 * does not substitute one for the other in either direction. The sub-navigation filters itself by
 * the same route map, so such a user sees this tab and nothing else in the bar — which is why the
 * page has to read as complete on its own rather than as a corner of an administrator's area.
 */

const ownSettingsSchema = z.object({
	voicemailToEmailIncludeLink: z.boolean(),
	voicemailToEmailIncludeTranscription: z.boolean(),
});

const EMPTY_FORM = {
	voicemailToEmailIncludeLink: true,
	voicemailToEmailIncludeTranscription: true,
};

export default function MySettingsPage() {
	const settings = useOwnSettings();
	const save = useSaveOwnSettings();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: ownSettingsSchema },
		onSubmit: async ({ value }) => {
			const parsed = ownSettingsSchema.parse(value);
			/**
			 * Both keys every time. `PATCH …/me/categories/:category` is a partial upsert, and unlike
			 * the `routing` category there is no setting here whose stored ABSENCE means something
			 * different from its stored default — both are plain booleans read by the mail renderer —
			 * so writing both is exactly what a form with two switches means by "Save".
			 */
			await save.mutateAsync({
				voicemailToEmailIncludeLink: parsed.voicemailToEmailIncludeLink,
				voicemailToEmailIncludeTranscription: parsed.voicemailToEmailIncludeTranscription,
			});
		},
	});

	const loaded = settings.data;
	useEffect(() => {
		if (loaded) {
			form.reset({
				voicemailToEmailIncludeLink: loaded.voicemailToEmailIncludeLink,
				voicemailToEmailIncludeTranscription: loaded.voicemailToEmailIncludeTranscription,
			});
		}
	}, [loaded, form]);

	return (
		<>
			<PageHeader
				title="My preferences"
				description="Settings that apply to you alone. Everything else in this area belongs to the whole organization."
			/>
			<SettingsNav />

			{settings.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading your preferences" />
					</CardBody>
				</Card>
			) : (
				<RequirePermission
					permissions={["settings.write.own"]}
					fallback={
						<Card>
							<CardHeader>
								<CardTitle>Voicemail notifications</CardTitle>
								<CardDescription>Your role can view these but not change them.</CardDescription>
							</CardHeader>
							<CardBody className="space-y-2 text-sm text-foreground">
								<p>
									Playback link: {loaded?.voicemailToEmailIncludeLink ? "included" : "not included"}
								</p>
								<p>
									Transcription:{" "}
									{loaded?.voicemailToEmailIncludeTranscription ? "included" : "not included"}
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
								<CardTitle>Voicemail notifications</CardTitle>
								<CardDescription>
									What your own voicemail emails contain. Whether they are sent at all is decided
									elsewhere: your mailbox carries a delivery mode, and your organization has a
									switch that can turn voicemail email off for everybody. These two only shape a
									message that is already being sent.
								</CardDescription>
							</CardHeader>
							<CardBody className="space-y-5">
								<form.Field name="voicemailToEmailIncludeLink">
									{(field) => (
										<SwitchField
											field={field}
											label="Include a playback link"
											description="A signed link to the recording, carrying the message id inside the signature and expiring within minutes. The audio itself is never attached, which is what keeps it revocable."
											disabled={save.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="voicemailToEmailIncludeTranscription">
									{(field) => (
										<SwitchField
											field={field}
											label="Include the transcription"
											description="Only where your mailbox has transcription switched on and one was produced. A message that has not been transcribed carries nothing here either way."
											disabled={save.isPending}
										/>
									)}
								</form.Field>

								<p className="max-w-prose text-xs text-muted-foreground">
									These start at whatever your organization set, and stay there until you change one
									— from then on yours is the answer that applies to your mail, and nobody
									else&rsquo;s.
								</p>
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
