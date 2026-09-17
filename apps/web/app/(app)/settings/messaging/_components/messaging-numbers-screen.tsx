"use client";

import { useState } from "react";
import { ResourceTable } from "~/components/pbx/resource-list";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { inputClassName } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/cn";
import {
	formatE164,
	numberClassLabel,
	registrationStatusPresentation,
	retentionLabel,
} from "~/lib/messaging/format";
import { MAX_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../../_context/session-context";
import {
	useCampaigns,
	useDisableMessagingNumber,
	useEnableMessagingNumber,
	useMessagingNumbers,
	useUpdateMessagingNumber,
} from "../../../_hooks/use-messaging-queries";
import { usePbxList } from "../../../_hooks/use-pbx-queries";
import { SettingsNav } from "../../_components/settings-nav";
import { MessagingSettingsNav } from "./messaging-settings-nav";
import type { MessagingNumberRow, NumberClass } from "~/lib/messaging/contracts";

/**
 * Which of this organization's DIDs can carry text messages, and how far each one has got with the
 * carriers.
 *
 * ## Messaging is a capability ON a voice number, not a number of its own
 *
 * `POST numbers` takes a `phoneNumberId` — the DID already in the inventory — so this screen never
 * orders anything. It lists the phone numbers that do NOT yet have messaging and offers to turn it
 * on for one, which is why the picker is a select of voice DIDs rather than a search of a carrier
 * catalogue.
 *
 * ## The registration reason is on the page, not in a tooltip
 *
 * `registrationReason` is the carrier's sentence about why a submission is pending or refused, and
 * it is the only place that answer exists. A `title` attribute would hide it from touch, from
 * keyboard users and from anybody who does not know to hover — so a non-registered row expands it
 * underneath the badge instead.
 *
 * ## Disable and delete are the same verb here, and the copy says so
 *
 * `DELETE numbers/:id` takes messaging OFF the DID; the phone number itself is untouched and the
 * calls keep arriving. Calling that "delete" in the UI would read as giving the number back to the
 * carrier, which is a different, expensive and irreversible thing on the Numbers screen.
 */
export function MessagingNumbersScreen() {
	const canManage = usePermission("messaging.manage");
	const numbers = useMessagingNumbers();
	const campaigns = useCampaigns();
	const enable = useEnableMessagingNumber();
	const update = useUpdateMessagingNumber();
	const disable = useDisableMessagingNumber();

	const [pendingDisable, setPendingDisable] = useState<MessagingNumberRow | null>(null);
	const [chosenPhoneNumberId, setChosenPhoneNumberId] = useState("");
	const [chosenClass, setChosenClass] = useState<NumberClass | "">("");

	/**
	 * The voice inventory, asked for in one page at the API's ceiling.
	 *
	 * A tenant with more DIDs than that has an inventory nobody picks from in a dropdown anyway,
	 * and paging a picker would hide the very number somebody came here to enable. The list is
	 * filtered client-side against what already has messaging, which is the one join this screen
	 * needs and the API does not offer.
	 */
	const phoneNumbers = usePbxList(PBX_RESOURCES.phoneNumbers, {
		page: 1,
		limit: MAX_PAGE_LIMIT,
	});
	const enabledPhoneNumberIds = new Set(numbers.rows.map((row) => row.phoneNumberId));
	const available = phoneNumbers.rows.filter((row) => !enabledPhoneNumberIds.has(row.id));

	return (
		<>
			<PageHeader
				title="Messaging"
				description="Which of this organization's numbers can send and receive text messages, and how far each one has got with the carriers."
			/>
			<SettingsNav />
			<MessagingSettingsNav />

			{canManage ? (
				<Card>
					<CardHeader>
						<CardTitle>Enable messaging on a number</CardTitle>
						<CardDescription>
							Messaging is a capability on a number you already own. Turning it on here does not
							order anything and does not change how calls to that number are routed.
						</CardDescription>
					</CardHeader>
					<CardBody className="flex flex-wrap items-end gap-3">
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor="messaging-phone-number"
								className="text-xs font-medium text-muted-foreground"
							>
								Phone number
							</label>
							<select
								id="messaging-phone-number"
								value={chosenPhoneNumberId}
								onChange={(event) => setChosenPhoneNumberId(event.target.value)}
								disabled={available.length === 0}
								className={cn(inputClassName, "w-64 pr-8")}
							>
								<option value="">
									{available.length === 0
										? "Every number already has messaging"
										: "Choose a number…"}
								</option>
								{available.map((row) => (
									<option key={row.id} value={row.id}>
										{formatE164(row.e164)}
										{row.label ? ` — ${row.label}` : ""}
									</option>
								))}
							</select>
						</div>

						<div className="flex flex-col gap-1.5">
							<label
								htmlFor="messaging-number-class"
								className="text-xs font-medium text-muted-foreground"
							>
								Class
							</label>
							<select
								id="messaging-number-class"
								value={chosenClass}
								onChange={(event) => setChosenClass(event.target.value as NumberClass | "")}
								className={cn(inputClassName, "w-44 pr-8")}
							>
								{/* Left blank by default: the server infers the class from the prefix, and a
								    guess of "local" for a +1800 number would file it with the wrong regulator. */}
								<option value="">Detect from the number</option>
								<option value="local">Local (10DLC)</option>
								<option value="toll-free">Toll-free</option>
							</select>
						</div>

						<Button
							variant="primary"
							loading={enable.isPending}
							disabled={chosenPhoneNumberId.length === 0}
							onClick={() => {
								enable.mutate(
									{
										phoneNumberId: chosenPhoneNumberId,
										...(chosenClass === "" ? {} : { numberClass: chosenClass }),
									},
									{
										onSuccess: () => {
											setChosenPhoneNumberId("");
											setChosenClass("");
										},
									},
								);
							}}
						>
							Enable messaging
						</Button>
					</CardBody>
				</Card>
			) : null}

			<ResourceTable
				rows={numbers.rows}
				isPending={numbers.query.isPending}
				filtered={false}
				caption="Numbers enabled for messaging"
				emptyTitle="No number can send or receive messages yet"
				emptyDescription="Enable messaging on one of this organization's phone numbers, then register a 10DLC brand and campaign — or verify it as a toll-free number."
				columns={[
					{
						key: "e164",
						header: "Number",
						className: "font-medium whitespace-nowrap",
						cell: (row) => formatE164(row.e164),
					},
					{
						key: "class",
						header: "Class",
						cell: (row) => (
							<Badge tone={row.numberClass === "toll-free" ? "accent" : "neutral"}>
								{numberClassLabel(row.numberClass)}
							</Badge>
						),
					},
					{
						key: "enabled",
						header: "Enabled",
						cell: (row) => (
							<Switch
								checked={row.enabled}
								disabled={!canManage || update.isPending}
								aria-label={`Messaging on ${row.e164}`}
								onCheckedChange={(checked) =>
									update.mutate({ id: row.id, values: { enabled: checked } })
								}
							/>
						),
					},
					{
						key: "registration",
						header: "Registration",
						cell: (row) => <RegistrationCell row={row} />,
					},
					{
						key: "campaign",
						header: "Campaign",
						cell: (row) =>
							row.numberClass === "toll-free" ? (
								<span className="text-sm text-muted-foreground">
									Toll-free — verified, not campaigned
								</span>
							) : (
								<select
									aria-label={`Campaign for ${row.e164}`}
									value={row.campaignId ?? ""}
									disabled={!canManage || update.isPending}
									onChange={(event) =>
										update.mutate({
											id: row.id,
											values: {
												// "" is the unassign, and the wire word for it is `null`.
												campaignId: event.target.value === "" ? null : event.target.value,
											},
										})
									}
									className={cn(inputClassName, "h-8 w-48 pr-8 text-sm")}
								>
									<option value="">Not assigned</option>
									{campaigns.rows.map((campaign) => (
										<option key={campaign.id} value={campaign.id}>
											{campaign.name}
										</option>
									))}
								</select>
							),
					},
					{
						key: "retention",
						header: "Retention",
						cell: (row) => (
							<span className="text-sm text-muted-foreground">
								{retentionLabel(row.retentionDays)}
							</span>
						),
					},
				]}
				rowActions={
					canManage
						? (row) => (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setPendingDisable(row)}
									aria-label={`Turn messaging off for ${row.e164}`}
								>
									Turn off
								</Button>
							)
						: undefined
				}
			/>

			<p className="max-w-prose text-xs text-muted-foreground">
				Retention is how long this platform keeps the message bodies and attachments on a number. An
				empty value means the organization&rsquo;s own default applies. Turning messaging off stops
				texts to and from a number; the number itself keeps taking calls.
			</p>

			<ConfirmDialog
				open={pendingDisable !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDisable(null);
					}
				}}
				title="Turn messaging off for this number?"
				description={
					pendingDisable
						? `${formatE164(pendingDisable.e164)} will stop sending and receiving text messages. Calls to it are unaffected, and the number stays in your inventory. Existing conversations are kept and become read-only.`
						: ""
				}
				confirmLabel="Turn messaging off"
				destructive
				pending={disable.isPending}
				onConfirm={() => {
					if (!pendingDisable) {
						return;
					}
					disable.mutate(pendingDisable.id, { onSuccess: () => setPendingDisable(null) });
				}}
			/>
		</>
	);
}

/**
 * The status badge and, when it is not `registered`, the carrier's own reason under it.
 *
 * The reason is rendered as text rather than as a `title`, because a tooltip is unreachable on a
 * touch screen and invisible to a keyboard user — and this sentence is the only explanation a
 * refused registration ever gets.
 */
function RegistrationCell({ row }: { row: MessagingNumberRow }) {
	const presentation = registrationStatusPresentation(row.registrationStatus);

	return (
		<div className="flex max-w-64 flex-col gap-1">
			<Badge tone={presentation.tone}>{presentation.label}</Badge>
			{row.registrationStatus !== "registered" && row.registrationReason ? (
				<span className="text-xs text-muted-foreground">{row.registrationReason}</span>
			) : null}
		</div>
	);
}
