"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { useEffect } from "react";
import { PromptSelect } from "~/components/pbx/resource-select";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardBody,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { SelectField, SwitchField, TextField, TextareaField } from "~/components/ui/form-fields";
import { changedSettings, DEFAULT_ALL_PARTY_REGIONS } from "~/lib/org-settings/client";
import {
	EMPTY_RECORDING_FORM,
	formatRegionList,
	fromRecordingFormValues,
	MAX_ALL_PARTY_REGIONS,
	recordingSettingsFormSchema,
	toRecordingFormValues,
} from "~/lib/org-settings/recording-form";
import { RECORDING_CONSENT_POLICIES, RECORDING_CONSENT_POLICY_LABELS } from "~/lib/pbx/contracts";
import { routes } from "~/lib/routes";
import { useSaveRecordingSettings } from "../../../_hooks/use-org-settings-queries";
import type { RecordingSettings } from "~/lib/org-settings/client";

const NO_CHANGES: Readonly<Record<string, unknown>> = {};

/**
 * The copy, hoisted out of the JSX because several of these sentences are the only place a
 * consequence is written down, and a paragraph buried in a prop is a paragraph nobody edits.
 */
const COPY = {
	retention:
		"0 keeps recordings indefinitely — it is not “no retention”. The window is stamped " +
		"onto each recording when it is written, so changing it reaches recordings made from now on " +
		"and never re-stamps the ones that already exist.",
	voicemailRetention:
		"0 keeps messages indefinitely. Unlike the recording window above, this one is evaluated " +
		"against each message's received date on every sweep — so shortening it does purge messages " +
		"that are already older than the new window.",
	policy:
		"What the parties to a recorded call are told before recording starts. “Say nothing” " +
		"means nothing is said here; it does not mean consent does not apply, because the region " +
		"list below can still force an announcement. A number or an inbound route may override this " +
		"for the calls that arrive on it.",
	prompt:
		"Played as the disclosure. Leave it empty to use the built-in announcement, so switching " +
		"disclosure on works on the first call rather than playing silence.",
	acceptDigit:
		"The digit a party presses to consent. It has to be the digit your prompt actually names.",
	declineDigit:
		"The digit a party presses to refuse. The recording is not started at all, and the refusal " +
		"is written to the call record.",
	autoPause:
		"Pauses the recorder while a caller is pressing keys and resumes once they stop, so card " +
		"details typed on the keypad are not captured even when the agent forgets to pause. " +
		"Individual extensions and queues can turn this on for themselves.",
} as const;

/**
 * The `recordings` category — how long recorded calls are kept, and what the people on them are
 * told.
 *
 * ## Why the gate is `recordings.configure` and the read is not
 *
 * `CATEGORY_PERMISSIONS` on the server puts the override on the WRITE alone. Reading stays
 * `settings.read`, because the policy is not itself sensitive and a screen that could not show it
 * could not explain what the narrower grant changes — so a role without `recordings.configure`
 * sees the policy, read-only, rather than a page that does not exist.
 *
 * ## Why this form sends a diff
 *
 * `changedSettings`, for the reason the routing form gives: a settings PATCH is a partial upsert,
 * and writing a key nobody touched turns an inherited default into a stored decision. It matters
 * most for the region list, where an absent row and a stored `[]` are different instructions that
 * the category read resolves identically.
 */
export function RecordingPolicyForm({ settings }: { settings: RecordingSettings | undefined }) {
	const save = useSaveRecordingSettings();

	const form = useForm({
		defaultValues: EMPTY_RECORDING_FORM,
		validators: { onSubmit: recordingSettingsFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = recordingSettingsFormSchema.parse(value);
			const next = fromRecordingFormValues(parsed);
			await save.mutateAsync(changedSettings(settings ?? next, next));
			// Re-base the form on what was just written, so Save goes quiet until the next edit.
			form.reset(toRecordingFormValues(next));
		},
	});

	useEffect(() => {
		if (settings) {
			form.reset(toRecordingFormValues(settings));
		}
	}, [settings, form]);

	return (
		<form
			noValidate
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<Card>
				<CardHeader>
					<CardTitle>Retention</CardTitle>
					<CardDescription>
						How long this organization keeps recorded calls and voicemail before they are purged.
						The two windows use the same units and the same meaning for 0.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="retentionDays">
						{(field) => (
							<TextField
								field={field}
								label="Keep recordings for (days)"
								required
								placeholder="0"
								description={COPY.retention}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>

					<form.Field name="voicemailRetentionDays">
						{(field) => (
							<TextField
								field={field}
								label="Keep voicemail messages for (days)"
								required
								placeholder="0"
								description={COPY.voicemailRetention}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>

					<div className="max-w-prose space-y-2 rounded-panel border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
						<p className="font-medium text-foreground">What a purge does</p>
						<p>
							The audio object is deleted first and the recording row is kept as a tombstone, with
							the date its media went. An audit entry is written naming that recording, so
							&ldquo;was this call recorded, and what happened to it?&rdquo; is still answerable
							after the audio is gone. Purged rows appear on the{" "}
							<Link
								href={routes.recordings}
								className="text-primary underline-offset-4 hover:underline"
							>
								recordings
							</Link>{" "}
							screen with no play button.
						</p>
					</div>
				</CardBody>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Disclosure</CardTitle>
					<CardDescription>
						What the people on a recorded call are told before recording starts, as against how long
						what they said is kept.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="consentPolicy">
						{(field) => (
							<SelectField
								field={field}
								label="Recording disclosure"
								description={COPY.policy}
								disabled={save.isPending}
								className="max-w-md"
							>
								{RECORDING_CONSENT_POLICIES.map((value) => (
									<option key={value} value={value}>
										{RECORDING_CONSENT_POLICY_LABELS[value]}
									</option>
								))}
							</SelectField>
						)}
					</form.Field>

					<form.Field name="consentPromptId">
						{(field) => (
							<PromptSelect
								id="recordingConsentPromptId"
								label="Disclosure prompt"
								value={field.state.value}
								onChange={(next) => field.handleChange(next)}
								emptyLabel="The built-in announcement"
								description={COPY.prompt}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>

					<div className="flex flex-wrap gap-5">
						<form.Field name="consentAcceptDigit">
							{(field) => (
								<TextField
									field={field}
									label="Consent accept digit"
									required
									placeholder="1"
									description={COPY.acceptDigit}
									disabled={save.isPending}
									className="max-w-xs"
								/>
							)}
						</form.Field>

						<form.Field name="consentDeclineDigit">
							{(field) => (
								<TextField
									field={field}
									label="Consent decline digit"
									required
									placeholder="2"
									description={COPY.declineDigit}
									disabled={save.isPending}
									className="max-w-xs"
								/>
							)}
						</form.Field>
					</div>
				</CardBody>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>All-party consent regions</CardTitle>
					<CardDescription>
						Regions where this organization treats every party to a call as needing to be told it is
						recorded. A call whose caller id or destination resolves into one of them is announced
						to on both sides, even when the disclosure above is &ldquo;say nothing&rdquo;. This list
						is a{" "}
						<strong className="font-medium text-foreground">
							configurable default, not legal advice
						</strong>{" "}
						— confirm your own obligations with counsel and edit it to match. The region mapping is
						written down in <code>docs/recording-compliance.md</code>, and it is approximate by
						construction: numbers are portable, so an area code no longer proves where somebody is
						standing.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="allPartyRegions">
						{(field) => (
							<TextareaField
								field={field}
								label="Regions"
								rows={4}
								description={`ISO 3166 codes — US-CA for a state, EU for the Union. One per line, or separated by commas. At most ${MAX_ALL_PARTY_REGIONS}. An empty list means no call is upgraded on jurisdiction alone.`}
								disabled={save.isPending}
								className="max-w-prose"
							/>
						)}
					</form.Field>

					<div>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							disabled={save.isPending}
							onClick={() =>
								form.setFieldValue("allPartyRegions", formatRegionList(DEFAULT_ALL_PARTY_REGIONS))
							}
						>
							Restore the platform&apos;s list
						</Button>
					</div>
				</CardBody>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Keypad entry</CardTitle>
					<CardDescription>
						PCI DSS prefers not capturing a card number at all to asking an agent to remember to
						pause. This is that preference as a switch — a backstop under the manual pause, not a
						replacement for it.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="autoPauseOnDtmf">
						{(field) => (
							<SwitchField
								field={field}
								label="Pause recording during keypad entry"
								description={COPY.autoPause}
								disabled={save.isPending}
								className="max-w-prose"
							/>
						)}
					</form.Field>
				</CardBody>
				<CardFooter>
					<form.Subscribe selector={(state) => state.values}>
						{(values) => {
							const parsed = recordingSettingsFormSchema.safeParse(values);
							const patch =
								settings && parsed.success
									? changedSettings(settings, fromRecordingFormValues(parsed.data))
									: NO_CHANGES;
							const count = Object.keys(patch).length;
							return (
								<>
									<p className="text-xs text-muted-foreground">
										{count === 0
											? "No unsaved changes."
											: `${count} setting${count === 1 ? "" : "s"} changed.`}
									</p>
									<Button
										type="submit"
										variant="primary"
										loading={save.isPending}
										disabled={count === 0}
									>
										Save changes
									</Button>
								</>
							);
						}}
					</form.Subscribe>
				</CardFooter>
			</Card>
		</form>
	);
}
