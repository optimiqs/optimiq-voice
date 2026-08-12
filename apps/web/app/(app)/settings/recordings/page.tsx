"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
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
import { TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { RECORDING_RETENTION_MAX_DAYS } from "~/lib/org-settings/client";
import { routes } from "~/lib/routes";
import { RequirePermission } from "../../_components/require-permission";
import {
	useRecordingSettings,
	useSaveRecordingSettings,
} from "../../_hooks/use-org-settings-queries";
import { SettingsNav } from "../_components/settings-nav";

/**
 * The `recordings` category of the settings cascade — one field, and a great deal of copy.
 *
 * ## Why the copy is the feature
 *
 * The control is a number box. Everything that could go wrong here is a mismatch between what a
 * user believes it does and what it does, and there are three of those, each stated on screen:
 *
 * 1. **Zero means for ever, not "nothing".** The platform's own `CDR_RECORDING_RETENTION_DAYS`
 *    uses exactly this vocabulary, and the catalogue matches it deliberately — two spellings for
 *    one number is how a tenant sets 30 and gets a month while an operator expects a fortnight. A
 *    blank box that meant "unset" would be a third spelling, so blank is not offered.
 * 2. **It reaches new recordings only.** `retention_until` is computed at WRITE time from the
 *    window in force then, and the sweeper acts on that stamped column — it never re-derives.
 *    Shortening the window does NOT start purging last year's audio, and somebody who assumes it
 *    does will believe a compliance obligation has been met when it has not.
 * 3. **A purge destroys the object and keeps a tombstone.** The row survives with `deletedAt` set
 *    and an audit entry is written naming the recording, so "was there a recording of that call,
 *    and what happened to it" stays answerable after the audio is gone.
 *
 * ## Why the gate is `recordings.configure` and the read is not
 *
 * `CATEGORY_PERMISSIONS` on the server puts the override on the WRITE alone. Reading stays
 * `settings.read` because the window is not itself sensitive and a screen that could not show it
 * could not explain what the narrower grant changes — so a role without `recordings.configure`
 * sees the policy, read-only, rather than a page that does not exist.
 */

const recordingSettingsSchema = z.object({
	retentionDays: z
		.string()
		.trim()
		.min(1, "Required — enter 0 to keep recordings indefinitely")
		.transform((value) => Number(value))
		.refine((value) => Number.isInteger(value), "Whole days only")
		.refine(
			(value) => value >= 0 && value <= RECORDING_RETENTION_MAX_DAYS,
			`Must be between 0 and ${RECORDING_RETENTION_MAX_DAYS}`,
		),
});

const EMPTY_FORM = { retentionDays: "0" };

function describeWindow(days: number): string {
	if (days === 0) {
		return "Recordings are kept indefinitely — nothing purges them.";
	}
	if (days === 1) {
		return "Recordings made from now on are purged after one day.";
	}
	return `Recordings made from now on are purged after ${days} days.`;
}

export default function RecordingSettingsPage() {
	const settings = useRecordingSettings();
	const save = useSaveRecordingSettings();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: recordingSettingsSchema },
		onSubmit: async ({ value }) => {
			const parsed = recordingSettingsSchema.parse(value);
			await save.mutateAsync({ retentionDays: parsed.retentionDays });
		},
	});

	const loaded = settings.data;
	useEffect(() => {
		if (loaded) {
			form.reset({ retentionDays: String(loaded.retentionDays) });
		}
	}, [loaded, form]);

	return (
		<>
			<PageHeader
				title="Recordings"
				description="How long this organization keeps recorded calls before they are purged."
			/>
			<SettingsNav />

			{settings.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading the recording policy" />
					</CardBody>
				</Card>
			) : (
				<RequirePermission
					permissions={["recordings.configure"]}
					fallback={
						<Card>
							<CardHeader>
								<CardTitle>Retention</CardTitle>
								<CardDescription>
									Your role can view this policy but not change it. Changing how long an
									organization keeps recorded calls is a separate grant from managing its other
									settings.
								</CardDescription>
							</CardHeader>
							<CardBody className="text-sm text-foreground">
								{describeWindow(loaded?.retentionDays ?? 0)}
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
								<CardTitle>Retention</CardTitle>
								<CardDescription>
									The window is stamped onto each recording when it is written. Changing it applies
									to recordings made from now on and never re-stamps recordings that already exist —
									so shortening it does not begin purging older audio.
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
											description={`0 keeps recordings indefinitely — it is not "no retention". At most ${RECORDING_RETENTION_MAX_DAYS.toLocaleString()} days (ten years).`}
											disabled={save.isPending}
											className="max-w-xs"
										/>
									)}
								</form.Field>

								<p className="max-w-prose text-sm text-muted-foreground">
									{describeWindow(loaded?.retentionDays ?? 0)}
								</p>

								<div className="max-w-prose space-y-2 rounded-panel border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
									<p className="font-medium text-foreground">What a purge does</p>
									<p>
										The audio object is deleted first and the recording row is kept as a tombstone,
										with the date its media went. An audit entry is written naming that recording,
										so &ldquo;was this call recorded, and what happened to it?&rdquo; is still
										answerable after the audio is gone. Purged rows appear on the{" "}
										<Link
											href={routes.recordings}
											className="text-primary underline-offset-4 hover:underline"
										>
											recordings
										</Link>{" "}
										screen with no play button.
									</p>
									<p>
										A recording can also be removed one at a time from that screen, by somebody
										holding the separate delete grant. That takes effect immediately rather than
										waiting for a window to run out.
									</p>
								</div>
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
