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
import { SelectField, TextareaField, TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { formatE164, tollFreeStatusPresentation } from "~/lib/messaging/format";
import {
	BRN_REQUIREMENT_NOTE,
	parseUrlList,
	tollFreeVerificationSchema,
	type TollFreeVerificationForm,
} from "~/lib/messaging/schemas";
import { RequirePermission } from "../../../../_components/require-permission";
import {
	useMessagingNumbers,
	useSubmitTollFreeVerification,
	useTollFreeVerifications,
} from "../../../../_hooks/use-messaging-queries";
import { SettingsNav } from "../../../_components/settings-nav";
import { MessagingSettingsNav } from "../../_components/messaging-settings-nav";
import type { TollFreeVerificationRow } from "~/lib/messaging/contracts";

/**
 * Toll-free verification — the other branch of the registration story.
 *
 * A toll-free number does not go through a 10DLC brand or a campaign. It is verified once, against
 * a form that asks the same questions a campaign does and several a campaign does not, and it is
 * reviewed by a person.
 *
 * ## The three BRN fields, and why the form argues for them
 *
 * `businessRegistrationNumber`, `businessRegistrationType` and `businessRegistrationCountry` became
 * mandatory for EVERY submission on 17 February 2026. A form that marked them optional would
 * produce submissions rejected days later with a reason nobody in this organization would connect
 * back to three blank boxes, so they are required here, they are grouped together, and the group
 * carries the date in one line. The country is checked for its shape too — `USA` and `us` are the
 * two things people type, and only one of them is right.
 *
 * The two policy links are required on the same terms: a reviewer opens them, and a submission
 * without them does not get read.
 *
 * ## One verification per number, and it is not editable here
 *
 * `POST toll-free-verifications` is the only write the API offers — there is no PATCH — because a
 * submission under review is a thing somebody else is holding. So a number that already has one
 * shows its status and its reason, and correcting a rejection means submitting again.
 */

const EMPTY_FORM: TollFreeVerificationForm = {
	messagingNumberId: "",
	businessName: "",
	businessWebsite: "",
	businessStreet: "",
	businessCity: "",
	businessState: "",
	businessPostalCode: "",
	businessCountry: "US",
	businessContactFirstName: "",
	businessContactLastName: "",
	businessContactEmail: "",
	businessContactPhone: "",
	businessRegistrationNumber: "",
	businessRegistrationType: "",
	businessRegistrationCountry: "US",
	privacyPolicyUrl: "",
	termsAndConditionsUrl: "",
	useCase: "",
	useCaseSummary: "",
	productionMessageContent: "",
	optInWorkflow: "",
	optInWorkflowImageUrls: "",
	messageVolume: "",
};

export function TollFreeVerificationScreen() {
	const verifications = useTollFreeVerifications();
	const numbers = useMessagingNumbers();
	const submit = useSubmitTollFreeVerification();
	const serverErrors = useServerFieldErrors();

	const submitted = new Set(verifications.rows.map((row) => row.messagingNumberId));
	const tollFreeNumbers = numbers.rows.filter(
		(row) => row.numberClass === "toll-free" && !submitted.has(row.id),
	);

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: tollFreeVerificationSchema },
		onSubmit: async ({ value }) => {
			const parsed = tollFreeVerificationSchema.parse(value);
			serverErrors.clear();
			try {
				await submit.mutateAsync({
					messagingNumberId: parsed.messagingNumberId,
					businessName: parsed.businessName,
					businessWebsite: parsed.businessWebsite,
					businessStreet: parsed.businessStreet,
					businessCity: parsed.businessCity,
					businessState: parsed.businessState,
					businessPostalCode: parsed.businessPostalCode,
					businessCountry: parsed.businessCountry.toUpperCase(),
					businessContactFirstName: parsed.businessContactFirstName,
					businessContactLastName: parsed.businessContactLastName,
					businessContactEmail: parsed.businessContactEmail,
					businessContactPhone: parsed.businessContactPhone,
					businessRegistrationNumber: parsed.businessRegistrationNumber,
					businessRegistrationType: parsed.businessRegistrationType,
					// Upper-cased on the way out: ISO 3166 codes are upper case, and the carriers match them.
					businessRegistrationCountry: parsed.businessRegistrationCountry.toUpperCase(),
					privacyPolicyUrl: parsed.privacyPolicyUrl,
					termsAndConditionsUrl: parsed.termsAndConditionsUrl,
					useCase: parsed.useCase,
					useCaseSummary: parsed.useCaseSummary,
					productionMessageContent: parsed.productionMessageContent,
					optInWorkflow: parsed.optInWorkflow,
					optInWorkflowImageUrls: parseUrlList(parsed.optInWorkflowImageUrls),
					messageVolume: parsed.messageVolume,
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
				title="Toll-free verification"
				description="A toll-free number is verified once, by a person at the carrier, instead of going through a 10DLC brand and campaign. Unverified toll-free traffic is filtered."
			/>
			<SettingsNav />
			<MessagingSettingsNav />

			{verifications.query.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading verifications" />
					</CardBody>
				</Card>
			) : verifications.rows.length === 0 ? (
				<EmptyState
					title="No toll-free number has been submitted"
					description="Enable messaging on a toll-free number first, then submit it for verification here. Review usually takes a few business days."
				/>
			) : (
				<div className="flex flex-col gap-4">
					{verifications.rows.map((row) => (
						<VerificationCard key={row.id} row={row} />
					))}
				</div>
			)}

			<RequirePermission permissions={["messaging.manage"]}>
				{tollFreeNumbers.length === 0 ? (
					<Card>
						<CardHeader>
							<CardTitle>Nothing to submit</CardTitle>
							<CardDescription>
								Every toll-free number with messaging enabled has already been submitted. Enable
								messaging on another toll-free number to submit it.
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
								<CardTitle>Submit a toll-free number</CardTitle>
								<CardDescription>
									A reviewer reads all of this and compares it against the traffic that follows. A
									summary that does not match what the number actually sends is the usual reason a
									submission is refused.
								</CardDescription>
							</CardHeader>
							<CardBody className="grid gap-5 md:grid-cols-2">
								<form.Field name="messagingNumberId">
									{(field) => (
										<SelectField
											field={field}
											label="Number"
											required
											submitError={serverErrors.errors.messagingNumberId}
											disabled={submit.isPending}
										>
											<option value="">Choose a toll-free number…</option>
											{tollFreeNumbers.map((row) => (
												<option key={row.id} value={row.id}>
													{formatE164(row.e164)}
												</option>
											))}
										</SelectField>
									)}
								</form.Field>

								<form.Field name="messageVolume">
									{(field) => (
										<TextField
											field={field}
											label="Estimated monthly volume"
											required
											description="Messages per month across this number."
											submitError={serverErrors.errors.messageVolume}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessName">
									{(field) => (
										<TextField
											field={field}
											label="Business name"
											required
											submitError={serverErrors.errors.businessName}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessWebsite">
									{(field) => (
										<TextField
											field={field}
											label="Business website"
											type="url"
											required
											description="A full https:// address the reviewer can open."
											submitError={serverErrors.errors.businessWebsite}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessStreet">
									{(field) => (
										<TextField
											field={field}
											label="Street"
											required
											submitError={serverErrors.errors.businessStreet}
											disabled={submit.isPending}
											className="md:col-span-2"
										/>
									)}
								</form.Field>

								<form.Field name="businessCity">
									{(field) => (
										<TextField
											field={field}
											label="City"
											required
											submitError={serverErrors.errors.businessCity}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessState">
									{(field) => (
										<TextField
											field={field}
											label="State or province"
											required
											submitError={serverErrors.errors.businessState}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessPostalCode">
									{(field) => (
										<TextField
											field={field}
											label="Postal code"
											required
											submitError={serverErrors.errors.businessPostalCode}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessCountry">
									{(field) => (
										<TextField
											field={field}
											label="Country"
											required
											description="Two-letter code."
											submitError={serverErrors.errors.businessCountry}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessContactFirstName">
									{(field) => (
										<TextField
											field={field}
											label="Contact first name"
											required
											submitError={serverErrors.errors.businessContactFirstName}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessContactLastName">
									{(field) => (
										<TextField
											field={field}
											label="Contact last name"
											required
											submitError={serverErrors.errors.businessContactLastName}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessContactEmail">
									{(field) => (
										<TextField
											field={field}
											label="Contact email"
											type="email"
											required
											submitError={serverErrors.errors.businessContactEmail}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="businessContactPhone">
									{(field) => (
										<TextField
											field={field}
											label="Contact phone"
											type="tel"
											required
											submitError={serverErrors.errors.businessContactPhone}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<div className="rounded-panel border border-border bg-muted/40 p-4 md:col-span-2">
									<h3 className="text-sm font-semibold text-foreground">Business registration</h3>
									{/* The one line that explains why these three are not optional. */}
									<p className="mt-0.5 text-xs text-muted-foreground">{BRN_REQUIREMENT_NOTE}</p>

									<div className="mt-4 grid gap-5 md:grid-cols-3">
										<form.Field name="businessRegistrationNumber">
											{(field) => (
												<TextField
													field={field}
													label="Registration number"
													required
													description="The company's registration or tax identifier."
													submitError={serverErrors.errors.businessRegistrationNumber}
													disabled={submit.isPending}
												/>
											)}
										</form.Field>

										<form.Field name="businessRegistrationType">
											{(field) => (
												<TextField
													field={field}
													label="Registration type"
													required
													description="What kind of identifier it is — EIN, VAT, company number."
													submitError={serverErrors.errors.businessRegistrationType}
													disabled={submit.isPending}
												/>
											)}
										</form.Field>

										<form.Field name="businessRegistrationCountry">
											{(field) => (
												<TextField
													field={field}
													label="Registration country"
													required
													description="Two-letter ISO code — US, not USA."
													submitError={serverErrors.errors.businessRegistrationCountry}
													disabled={submit.isPending}
												/>
											)}
										</form.Field>
									</div>
								</div>

								<form.Field name="privacyPolicyUrl">
									{(field) => (
										<TextField
											field={field}
											label="Privacy policy URL"
											type="url"
											required
											description="Required. The reviewer opens it."
											submitError={serverErrors.errors.privacyPolicyUrl}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="termsAndConditionsUrl">
									{(field) => (
										<TextField
											field={field}
											label="Terms and conditions URL"
											type="url"
											required
											description="Required, and it must mention the messaging programme."
											submitError={serverErrors.errors.termsAndConditionsUrl}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="useCase">
									{(field) => (
										<TextField
											field={field}
											label="Use case"
											required
											submitError={serverErrors.errors.useCase}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="useCaseSummary">
									{(field) => (
										<TextareaField
											field={field}
											label="Use case summary"
											required
											rows={3}
											description="What this number sends, and to whom."
											submitError={serverErrors.errors.useCaseSummary}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="productionMessageContent">
									{(field) => (
										<TextareaField
											field={field}
											label="Production message content"
											required
											rows={3}
											description="A real message, as it will be sent — including the opt-out line."
											submitError={serverErrors.errors.productionMessageContent}
											disabled={submit.isPending}
											className="md:col-span-2"
										/>
									)}
								</form.Field>

								<form.Field name="optInWorkflow">
									{(field) => (
										<TextareaField
											field={field}
											label="Opt-in workflow"
											required
											rows={3}
											description="How somebody consents, step by step."
											submitError={serverErrors.errors.optInWorkflow}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="optInWorkflowImageUrls">
									{(field) => (
										<TextareaField
											field={field}
											label="Opt-in screenshots"
											rows={3}
											description="One URL per line — the form or checkbox where consent is given. A submission with none is often sent back."
											submitError={serverErrors.errors.optInWorkflowImageUrls}
											disabled={submit.isPending}
										/>
									)}
								</form.Field>
							</CardBody>
							<CardFooter>
								<Button type="submit" variant="primary" loading={submit.isPending}>
									Submit for verification
								</Button>
							</CardFooter>
						</form>
					</Card>
				)}
			</RequirePermission>
		</>
	);
}

function VerificationCard({ row }: { row: TollFreeVerificationRow }) {
	const status = tollFreeStatusPresentation(row.status);

	return (
		<Card>
			<CardHeader className="flex-row items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<CardTitle>{formatE164(row.e164)}</CardTitle>
					<CardDescription>
						{row.businessName} · {row.useCase}
					</CardDescription>
				</div>
				<Badge tone={status.tone}>{status.label}</Badge>
			</CardHeader>
			<CardBody className="space-y-2 text-sm">
				{row.statusReason ? (
					<p className="text-foreground">{row.statusReason}</p>
				) : (
					<p className="text-muted-foreground">
						The carrier has not attached a reason to this status.
					</p>
				)}
				<p className="text-xs text-muted-foreground" data-tabular>
					{row.submittedAt
						? `Submitted ${new Date(row.submittedAt).toLocaleString()}`
						: "Not submitted yet"}
				</p>
				{row.status === "rejected" ? (
					<p className="text-xs text-muted-foreground">
						A refused verification cannot be edited — correct the details and submit the number
						again.
					</p>
				) : null}
			</CardBody>
		</Card>
	);
}
