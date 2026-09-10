"use client";

import { useState } from "react";
import { ResourceTable } from "~/components/pbx/resource-list";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName, Input } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import { cn } from "~/lib/cn";
import { formatE164, optOutSourceLabel } from "~/lib/messaging/format";
import { manualOptOutSchema } from "~/lib/messaging/schemas";
import { usePermission } from "../../../../_context/session-context";
import {
	useCreateOptOut,
	useDeleteOptOut,
	useMessagingNumbers,
	useOptOuts,
} from "../../../../_hooks/use-messaging-queries";
import { SettingsNav } from "../../../_components/settings-nav";
import { MessagingSettingsNav } from "../../_components/messaging-settings-nav";
import type { OptOutRow } from "~/lib/messaging/contracts";

/**
 * The suppression list — who this organization may no longer text, and why.
 *
 * ## The three sources are not the same fact, and the table keeps them apart
 *
 * `keyword` is the recipient themselves: they texted STOP, and the platform recorded it. `carrier`
 * is the network telling us on their behalf. `manual` is somebody in this organization recording a
 * withdrawal made somewhere else — on the phone, in a shop, by email. Only the third is one this
 * organization can honestly reverse on its own say-so, which is exactly why the source column is
 * shown and not collapsed into a date.
 *
 * ## Removing an entry is not "delete"; it is recording consent to resume
 *
 * `DELETE opt-outs/:id` puts a person back on the list of people this organization will text. The
 * confirmation says that in plain words, including the part that matters legally: the platform is
 * recording that CONSENT WAS GIVEN AGAIN, and the person doing it is asserting that it was. A
 * dialog that said "are you sure you want to delete this row?" would be asking about the wrong
 * thing entirely.
 */
export function MessagingOptOutsScreen() {
	const canManage = usePermission("messaging.manage");
	const numbers = useMessagingNumbers();
	const [numberId, setNumberId] = useState("");
	const selectedNumberId = numberId.length > 0 ? numberId : numbers.rows[0]?.id;

	const optOuts = useOptOuts(selectedNumberId);
	const create = useCreateOptOut();
	const remove = useDeleteOptOut();

	const [remoteE164, setRemoteE164] = useState("");
	const [addError, setAddError] = useState<string | undefined>(undefined);
	const [pendingRemove, setPendingRemove] = useState<OptOutRow | null>(null);

	const numberById = new Map(numbers.rows.map((row) => [row.id, row]));

	return (
		<>
			<PageHeader
				title="Opt-outs"
				description="People who have withdrawn consent to receive messages on one of this organization's numbers. A send to anyone on this list is refused before it reaches the carrier."
			/>
			<SettingsNav />
			<MessagingSettingsNav />

			{numbers.rows.length === 0 ? (
				<EmptyState
					title="No messaging numbers"
					description="Enable messaging on a number first — a suppression list belongs to a number, because consent is given to be texted by one."
				/>
			) : (
				<>
					<div className="flex flex-col gap-1.5">
						<label htmlFor="opt-out-number" className="text-xs font-medium text-muted-foreground">
							Number
						</label>
						<select
							id="opt-out-number"
							value={selectedNumberId ?? ""}
							onChange={(event) => setNumberId(event.target.value)}
							className={cn(inputClassName, "w-64 pr-8")}
						>
							{numbers.rows.map((row) => (
								<option key={row.id} value={row.id}>
									{formatE164(row.e164)}
								</option>
							))}
						</select>
					</div>

					{canManage ? (
						<Card>
							<CardHeader>
								<CardTitle>Record an opt-out</CardTitle>
								<CardDescription>
									For a withdrawal made somewhere other than by text — on a call, in person, by
									email. It takes effect immediately and applies to the selected number.
								</CardDescription>
							</CardHeader>
							<CardBody className="flex flex-wrap items-end gap-3">
								<div className="flex flex-col gap-1.5">
									<label htmlFor="opt-out-remote" className="text-sm font-medium text-foreground">
										Number to suppress
									</label>
									<Input
										id="opt-out-remote"
										value={remoteE164}
										placeholder="+15551234567"
										onChange={(event) => {
											setRemoteE164(event.target.value);
											setAddError(undefined);
										}}
										className="w-56"
										aria-invalid={addError ? true : undefined}
										aria-describedby={addError ? "opt-out-remote-error" : undefined}
									/>
								</div>
								<Button
									variant="primary"
									loading={create.isPending}
									onClick={() => {
										const parsed = manualOptOutSchema.safeParse({
											messagingNumberId: selectedNumberId ?? "",
											remoteE164: remoteE164.trim(),
										});
										if (!parsed.success) {
											setAddError(
												parsed.error.issues[0]?.message ??
													"Enter the number in E.164 form, starting with + and the country code",
											);
											return;
										}
										create.mutate(parsed.data, {
											onSuccess: () => setRemoteE164(""),
										});
									}}
								>
									Add opt-out
								</Button>
								{addError ? (
									<p id="opt-out-remote-error" role="alert" className="w-full text-xs text-danger">
										{addError}
									</p>
								) : null}
							</CardBody>
						</Card>
					) : null}

					<ResourceTable
						rows={optOuts.rows}
						isPending={optOuts.query.isPending}
						filtered={false}
						caption="Suppressed numbers"
						emptyTitle="Nobody has opted out"
						emptyDescription="When somebody replies STOP, or a carrier tells us they have withdrawn consent, they appear here and this platform stops sending to them."
						columns={[
							{
								key: "remote",
								header: "Number",
								className: "font-medium whitespace-nowrap",
								cell: (row) => formatE164(row.remoteE164),
							},
							{
								key: "source",
								header: "Source",
								cell: (row) => (
									<Badge tone={row.source === "manual" ? "neutral" : "accent"}>
										{optOutSourceLabel(row.source)}
									</Badge>
								),
							},
							{
								key: "keyword",
								header: "Keyword",
								cell: (row) =>
									row.keyword ? (
										<span className="font-mono text-xs">{row.keyword}</span>
									) : (
										<span className="text-sm text-muted-foreground">—</span>
									),
							},
							{
								key: "createdAt",
								header: "When",
								cell: (row) => (
									<span className="text-sm text-muted-foreground" data-tabular>
										{new Date(row.createdAt).toLocaleString()}
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
											aria-label={`Resume messaging to ${row.remoteE164}`}
											onClick={() => setPendingRemove(row)}
										>
											Resume messaging
										</Button>
									)
								: undefined
						}
					/>

					<p className="max-w-prose text-xs text-muted-foreground">
						An opt-out is per number: somebody who stopped messages from one of this
						organization&rsquo;s numbers has not stopped messages from the others, because consent
						was given to be texted by one. Entries with a keyword came from the person themselves.
					</p>
				</>
			)}

			<ConfirmDialog
				open={pendingRemove !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingRemove(null);
					}
				}}
				title="Resume messaging to this number?"
				description={
					pendingRemove
						? `${formatE164(pendingRemove.remoteE164)} ${
								pendingRemove.source === "keyword"
									? "asked to stop receiving messages by texting a stop keyword."
									: pendingRemove.source === "carrier"
										? "was reported by the carrier as having withdrawn consent."
										: "was added to this list by somebody in this organization."
							} Removing this entry records that they have given consent again, and this platform will resume sending to them from ${
								numberById.get(pendingRemove.messagingNumberId)?.e164 ?? "this number"
							}. Only do this if you have that consent.`
						: ""
				}
				confirmLabel="Record consent and resume"
				destructive
				pending={remove.isPending}
				onConfirm={() => {
					if (!pendingRemove) {
						return;
					}
					remove.mutate(pendingRemove.id, { onSuccess: () => setPendingRemove(null) });
				}}
			/>
		</>
	);
}
