"use client";

import { useForm } from "@tanstack/react-form";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardBody,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { Input } from "~/components/ui/field";
import { SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import {
	campaignStatusPresentation,
	describeQuietHours,
	formatE164,
	registrationStatusPresentation,
} from "~/lib/messaging/format";
import {
	CAMPAIGN_SAMPLE_MAX,
	campaignSchema,
	parseKeywords,
	type CampaignForm,
} from "~/lib/messaging/schemas";
import { RequirePermission } from "../../../../_components/require-permission";
import {
	useBrands,
	useCampaigns,
	useCreateCampaign,
} from "../../../../_hooks/use-messaging-queries";
import { SettingsNav } from "../../../_components/settings-nav";
import { MessagingSettingsNav } from "../../_components/messaging-settings-nav";
import type { CampaignRow } from "~/lib/messaging/contracts";

/**
 * 10DLC campaigns — what this organization actually intends to send, and on which numbers.
 *
 * ## Why the samples and the flow are long text boxes rather than a wizard
 *
 * The registry reads these. Two to five sample messages, a description of how somebody comes to
 * receive them, the HELP and STOP replies — these are what a human reviewer at a carrier compares
 * against the traffic, and a campaign is rejected when they do not match. A form that made them
 * feel like formalities would produce campaigns that get refused, so they are full-width, they say
 * what they are for, and none of them is optional.
 *
 * ## Quiet hours are a campaign property, and this is the only place they are set
 *
 * They are why the composer can refuse a send at 21:40 with a sentence naming the window. The zone
 * is an IANA name and not an offset, deliberately: a window that must hold at 21:00 local has to
 * hold across a daylight-saving change, which `EST` cannot express.
 *
 * ## Numbers are assigned from the Numbers screen, and listed here
 *
 * One direction, one place. Assigning from both screens would give an operator two controls that
 * write the same column and no way to tell which one they last used; this side shows what the
 * campaign holds so a rejected campaign's blast radius is visible.
 */

const EMPTY_FORM: CampaignForm = {
	name: "",
	useCase: "",
	description: "",
	sampleMessages: ["", ""],
	messageFlow: "",
	helpMessage: "Reply HELP for help. Message and data rates may apply.",
	optOutMessage: "You are unsubscribed and will receive no further messages.",
	optInKeywords: "START",
	optOutKeywords: "STOP",
	helpKeywords: "HELP",
	embeddedLink: false,
	ageGated: false,
	quietHoursEnabled: false,
	quietHoursStart: "21:00",
	quietHoursEnd: "08:00",
	quietHoursTimeZone: "America/New_York",
};

export function MessagingCampaignsScreen() {
	const campaigns = useCampaigns();
	const { brand } = useBrands();
	const create = useCreateCampaign();
	const serverErrors = useServerFieldErrors();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: campaignSchema },
		onSubmit: async ({ value }) => {
			const parsed = campaignSchema.parse(value);
			serverErrors.clear();
			try {
				await create.mutateAsync({
					name: parsed.name,
					useCase: parsed.useCase,
					description: parsed.description,
					sampleMessages: [...parsed.sampleMessages],
					messageFlow: parsed.messageFlow,
					helpMessage: parsed.helpMessage,
					optOutMessage: parsed.optOutMessage,
					optInKeywords: parseKeywords(parsed.optInKeywords),
					optOutKeywords: parseKeywords(parsed.optOutKeywords),
					helpKeywords: parseKeywords(parsed.helpKeywords),
					embeddedLink: parsed.embeddedLink,
					ageGated: parsed.ageGated,
					/**
					 * Omitted entirely when off. A strict body reads `quietHours: null` and no key at all
					 * as the same thing, and the second is the one that cannot be misread as "clear the
					 * window I never set".
					 */
					...(parsed.quietHoursEnabled
						? {
								quietHours: {
									start: parsed.quietHoursStart,
									end: parsed.quietHoursEnd,
									timeZone: parsed.quietHoursTimeZone,
								},
							}
						: {}),
				});
				form.reset(EMPTY_FORM);
			} catch (error) {
				serverErrors.capture(error);
				throw error;
			}
		},
	});

	return (
		<>
			<PageHeader
				title="Campaigns"
				description="What this organization intends to send on its local numbers, as filed with the campaign registry. Every local number has to sit on an approved campaign before it can send."
			/>
			<SettingsNav />
			<MessagingSettingsNav />

			{campaigns.query.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading campaigns" />
					</CardBody>
				</Card>
			) : campaigns.rows.length === 0 ? (
				<EmptyState
					title="No campaigns yet"
					description="A campaign describes one kind of message — appointment reminders, support replies, order updates — and carries the sample messages and opt-in story the carriers review."
				/>
			) : (
				<div className="flex flex-col gap-4">
					{campaigns.rows.map((campaign) => (
						<CampaignCard key={campaign.id} campaign={campaign} />
					))}
				</div>
			)}

			<RequirePermission permissions={["messaging.manage"]}>
				{brand === undefined ? (
					<Card>
						<CardHeader>
							<CardTitle>File the brand first</CardTitle>
							<CardDescription>
								A campaign is registered against a brand, so this organization&rsquo;s 10DLC brand
								has to exist before one can be created. It is the previous tab.
							</CardDescription>
						</CardHeader>
					</Card>
				) : (
					<Card>
						<form
							noValidate
							onSubmit={(event) => {
								event.preventDefault();
								void form.handleSubmit();
							}}
						>
							<CardHeader>
								<CardTitle>New campaign</CardTitle>
								<CardDescription>
									A human reviewer at the carrier compares these against your real traffic. A
									campaign whose samples do not look like what it sends is the most common
									rejection.
								</CardDescription>
							</CardHeader>
							<CardBody className="grid gap-5 md:grid-cols-2">
								<form.Field name="name">
									{(field) => (
										<TextField
											field={field}
											label="Campaign name"
											required
											submitError={serverErrors.errors.name}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="useCase">
									{(field) => (
										<TextField
											field={field}
											label="Use case"
											required
											description="The registry's category — customer care, delivery notifications, two-factor."
											submitError={serverErrors.errors.useCase}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="description">
									{(field) => (
										<TextareaField
											field={field}
											label="Description"
											required
											rows={3}
											description="What this campaign is for, in your own words."
											submitError={serverErrors.errors.description}
											disabled={create.isPending}
											className="md:col-span-2"
										/>
									)}
								</form.Field>

								<form.Field name="sampleMessages" mode="array">
									{(field) => (
										<div className="flex flex-col gap-2 md:col-span-2">
											<span className="text-sm font-medium text-foreground">
												Sample messages
												<span aria-hidden="true" className="ml-0.5 text-danger">
													*
												</span>
											</span>
											<span className="text-xs text-muted-foreground">
												Between two and five, and they must read like the real thing — including the
												opt-out line you actually send.
											</span>
											{field.state.value.map((sample, index) => (
												// eslint-disable-next-line react/no-array-index-key -- the rows are positional and have no identity of their own; a sample's meaning IS its position in the submission.
												<div key={index} className="flex items-center gap-2">
													<Input
														aria-label={`Sample message ${String(index + 1)}`}
														value={sample}
														disabled={create.isPending}
														onChange={(event) => {
															const next = [...field.state.value];
															next[index] = event.target.value;
															field.handleChange(next);
														}}
													/>
													{field.state.value.length > 2 ? (
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Remove sample message ${String(index + 1)}`}
															onClick={() =>
																field.handleChange(
																	field.state.value.filter((_, other) => other !== index),
																)
															}
														>
															Remove
														</Button>
													) : null}
												</div>
											))}
											{field.state.value.length < CAMPAIGN_SAMPLE_MAX ? (
												<div>
													<Button
														size="sm"
														variant="secondary"
														onClick={() => field.handleChange([...field.state.value, ""])}
													>
														Add a sample
													</Button>
												</div>
											) : null}
											{serverErrors.errors.sampleMessages ? (
												<p role="alert" className="text-xs text-danger">
													{serverErrors.errors.sampleMessages}
												</p>
											) : null}
										</div>
									)}
								</form.Field>

								<form.Field name="messageFlow">
									{(field) => (
										<TextareaField
											field={field}
											label="Message flow"
											required
											rows={3}
											description="How somebody comes to receive these — the opt-in, in the order it happens."
											submitError={serverErrors.errors.messageFlow}
											disabled={create.isPending}
											className="md:col-span-2"
										/>
									)}
								</form.Field>

								<form.Field name="helpMessage">
									{(field) => (
										<TextareaField
											field={field}
											label="HELP reply"
											required
											rows={2}
											description="Sent verbatim when somebody texts a help keyword."
											submitError={serverErrors.errors.helpMessage}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="optOutMessage">
									{(field) => (
										<TextareaField
											field={field}
											label="STOP reply"
											required
											rows={2}
											description="The confirmation somebody gets when they opt out. It is the last message they will receive."
											submitError={serverErrors.errors.optOutMessage}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="optInKeywords">
									{(field) => (
										<TextField
											field={field}
											label="Opt-in keywords"
											description="Comma separated. Matched case-insensitively."
											submitError={serverErrors.errors.optInKeywords}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="optOutKeywords">
									{(field) => (
										<TextField
											field={field}
											label="Opt-out keywords"
											required
											description="STOP is mandatory everywhere; add any others you honour."
											submitError={serverErrors.errors.optOutKeywords}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="helpKeywords">
									{(field) => (
										<TextField
											field={field}
											label="Help keywords"
											submitError={serverErrors.errors.helpKeywords}
											disabled={create.isPending}
										/>
									)}
								</form.Field>

								<div className="flex flex-col gap-4 md:col-span-2">
									<form.Field name="embeddedLink">
										{(field) => (
											<SwitchField
												field={field}
												label="Messages contain links"
												description="Declaring this is not optional — an undeclared link is a common reason traffic is filtered."
												disabled={create.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="ageGated">
										{(field) => (
											<SwitchField
												field={field}
												label="Age-gated content"
												description="Alcohol, tobacco, cannabis, firearms or gambling."
												disabled={create.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="quietHoursEnabled">
										{(field) => (
											<SwitchField
												field={field}
												label="Quiet hours"
												description="A window in which this platform refuses to send on this campaign, in the recipients' own time."
												disabled={create.isPending}
											/>
										)}
									</form.Field>
								</div>

								<form.Subscribe selector={(state) => state.values.quietHoursEnabled}>
									{(enabled) =>
										enabled ? (
											<div className="grid gap-4 md:col-span-2 md:grid-cols-3">
												<form.Field name="quietHoursStart">
													{(field) => (
														<TextField
															field={field}
															label="Quiet from"
															required
															description="24-hour, HH:MM."
															submitError={serverErrors.errors.quietHoursStart}
															disabled={create.isPending}
														/>
													)}
												</form.Field>
												<form.Field name="quietHoursEnd">
													{(field) => (
														<TextField
															field={field}
															label="Quiet until"
															required
															description="An end before the start crosses midnight, which is the usual case."
															submitError={serverErrors.errors.quietHoursEnd}
															disabled={create.isPending}
														/>
													)}
												</form.Field>
												<form.Field name="quietHoursTimeZone">
													{(field) => (
														<TextField
															field={field}
															label="Time zone"
															required
															description="An IANA name such as America/New_York — not EST, which ignores daylight saving."
															submitError={serverErrors.errors.quietHoursTimeZone}
															disabled={create.isPending}
														/>
													)}
												</form.Field>
											</div>
										) : null
									}
								</form.Subscribe>
							</CardBody>
							<CardFooter>
								<Button type="submit" variant="primary" loading={create.isPending}>
									Submit campaign
								</Button>
							</CardFooter>
						</form>
					</Card>
				)}
			</RequirePermission>
		</>
	);
}

/**
 * One campaign: its state, the registry's reason, what the carrier will let it send per minute, and
 * the numbers it covers.
 *
 * Throughput is on the card rather than buried, because it is the number that decides whether a
 * campaign is fit for what somebody is about to do with it — a 15-per-minute campaign and a list of
 * four thousand recipients is a fact worth knowing before the list is uploaded, not after.
 */
function CampaignCard({ campaign }: { campaign: CampaignRow }) {
	const status = campaignStatusPresentation(campaign.status);

	return (
		<Card>
			<CardHeader className="flex-row items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<CardTitle>{campaign.name}</CardTitle>
					<CardDescription>
						{campaign.useCase} · {campaign.description}
					</CardDescription>
				</div>
				<Badge tone={status.tone}>{status.label}</Badge>
			</CardHeader>
			<CardBody className="space-y-3 text-sm">
				{campaign.statusReason ? <p className="text-foreground">{campaign.statusReason}</p> : null}

				<dl className="grid gap-3 sm:grid-cols-3">
					<div>
						<dt className="text-xs text-muted-foreground">Throughput</dt>
						<dd className="text-foreground" data-tabular>
							{campaign.throughputPerMinute === null
								? "Not assigned yet"
								: `${String(campaign.throughputPerMinute)} messages per minute`}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">Quiet hours</dt>
						<dd className="text-foreground">
							{campaign.quietHours ? describeQuietHours(campaign.quietHours) : "None"}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">Declared</dt>
						<dd className="text-foreground">
							{[campaign.embeddedLink ? "Links" : null, campaign.ageGated ? "Age-gated" : null]
								.filter(Boolean)
								.join(", ") || "Neither links nor age-gated"}
						</dd>
					</div>
				</dl>

				<div>
					<p className="text-xs text-muted-foreground">Numbers on this campaign</p>
					{campaign.numbers.length === 0 ? (
						<p className="text-muted-foreground">
							None yet — assign one from the Numbers tab, where the campaign column lives.
						</p>
					) : (
						<ul className="mt-1 flex flex-wrap gap-2">
							{campaign.numbers.map((number) => {
								const registration = registrationStatusPresentation(number.registrationStatus);
								return (
									<li key={number.messagingNumberId}>
										<Badge tone={registration.tone}>
											{formatE164(number.e164)} · {registration.label}
										</Badge>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</CardBody>
		</Card>
	);
}
