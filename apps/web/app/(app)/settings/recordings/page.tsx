"use client";

import Link from "next/link";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { RECORDING_CONSENT_POLICY_LABELS } from "~/lib/pbx/contracts";
import { routes } from "~/lib/routes";
import { RequirePermission } from "../../_components/require-permission";
import { useRecordingSettings } from "../../_hooks/use-org-settings-queries";
import { SettingsNav } from "../_components/settings-nav";
import { DataErasurePanel } from "./_components/data-erasure-panel";
import { RecordingPolicyForm } from "./_components/recording-policy-form";
import type { RecordingSettings } from "~/lib/org-settings/client";

/**
 * The `recordings` category of the settings cascade, plus the one act that is not a setting.
 *
 * ## Two halves, two grants
 *
 * The form is POLICY — how long recorded calls are kept, what the parties are told, which
 * jurisdictions force an announcement — and it is written under `recordings.configure`. Reading it
 * stays `settings.read`, because a role that can see the policy but not change it is exactly what
 * the narrower grant means, and a page that vanished would not explain that.
 *
 * The erasure panel is an ACT aimed at one person, it cannot be undone, and it is written under
 * `recordings.delete`. It is fenced into its own card at the bottom rather than folded in above,
 * so an irreversible button is never in the tab order of a settings form.
 *
 * ## Why the copy insists the region list is not legal advice
 *
 * The platform ships a default list of all-party consent jurisdictions because a default of
 * "nowhere" would silently give every tenant the weakest posture. It is a POLICY DEFAULT: this
 * platform cannot know a tenant's obligations, the E.164 → region mapping is approximate because
 * numbers are portable, and `docs/recording-compliance.md` says both in as many words. A screen
 * that presented the list as settled law would be the most expensive sentence in the product.
 */
export default function RecordingSettingsPage() {
	const settings = useRecordingSettings();
	const loaded = settings.data;

	return (
		<>
			<PageHeader
				title="Recordings"
				description="How long this organization keeps recorded calls, and what the people on them are told."
			/>
			<SettingsNav />

			{settings.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading the recording policy" />
					</CardBody>
				</Card>
			) : (
				<div className="flex flex-col gap-6">
					<RequirePermission
						permissions={["recordings.configure"]}
						fallback={<ReadOnlyView settings={loaded} />}
					>
						<RecordingPolicyForm settings={loaded} />
					</RequirePermission>

					<RequirePermission permissions={["recordings.delete"]}>
						<DataErasurePanel />
					</RequirePermission>
				</div>
			)}
		</>
	);
}

/**
 * What a role holding `settings.read` and not `recordings.configure` sees.
 *
 * The whole policy, stated in sentences rather than in disabled controls. A greyed-out form reads
 * as a bug — people click it — and it would also imply that the missing grant is about editing
 * these particular boxes rather than about who may change an organization's evidence posture.
 */
function ReadOnlyView({ settings }: { settings: RecordingSettings | undefined }) {
	const retention = settings?.retentionDays ?? 0;
	const voicemail = settings?.voicemailRetentionDays ?? 0;
	const regions = settings?.allPartyRegions ?? [];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Recording policy</CardTitle>
				<CardDescription>
					Your role can view this policy but not change it. Changing how long an organization keeps
					recorded calls, or what it tells the people on them, is a separate grant from managing its
					other settings.
				</CardDescription>
			</CardHeader>
			<CardBody className="space-y-3 text-sm text-foreground">
				<p>{describeWindow("Recordings", retention)}</p>
				<p>{describeWindow("Voicemail messages", voicemail)}</p>
				<p>
					Disclosure:{" "}
					{RECORDING_CONSENT_POLICY_LABELS[settings?.consentPolicy ?? "none"].toLowerCase()}.
				</p>
				<p>
					{regions.length === 0
						? "No regions are treated as requiring every party to be told."
						: `Every party is told on a call touching ${regions.join(", ")}. That list is a configurable default, not legal advice.`}
				</p>
				<p>
					{settings?.autoPauseOnDtmf === true
						? "Recording pauses while a caller is pressing keys."
						: "Recording does not pause while a caller is pressing keys."}
				</p>
				<p className="text-xs text-muted-foreground">
					Recordings themselves are on the{" "}
					<Link
						href={routes.recordings}
						className="text-primary underline-offset-4 hover:underline"
					>
						recordings
					</Link>{" "}
					screen.
				</p>
			</CardBody>
		</Card>
	);
}

function describeWindow(what: string, days: number): string {
	if (days === 0) {
		return `${what} are kept indefinitely — nothing purges them.`;
	}
	if (days === 1) {
		return `${what} are purged after one day.`;
	}
	return `${what} are purged after ${days} days.`;
}
