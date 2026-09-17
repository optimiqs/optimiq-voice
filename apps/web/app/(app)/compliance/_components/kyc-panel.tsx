"use client";

import { useForm } from "@tanstack/react-form";
import { useEffect } from "react";
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
import { SelectField, TextareaField, TextField } from "~/components/ui/form-fields";
import { LoadingPanel } from "~/components/ui/spinner";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { KYC_ENTITY_TYPES, type KycDecision, type KycRecord } from "~/lib/pbx/contracts";
import { kycFormSchema, type KycFormValues } from "~/lib/pbx/schemas";
import { RequirePermission } from "../../_components/require-permission";
import { useKycRecord, useKycRecordSave } from "../../_hooks/use-pbx-queries";
import type { BadgeTone } from "~/lib/cdr/format";

/**
 * The organization's KYC record: the legal entity a carrier is actually selling to.
 *
 * ## The decision is the first thing on the page, and `needs-info` is why
 *
 * Three of the four decisions are things that happened TO the tenant and one is a question they can
 * answer. `needs-info` means a reviewer asked for something and wrote what in `reviewNotes`, so the
 * notes are rendered whenever they exist rather than only on a rejection — a reviewer who approved
 * with a caveat has said something worth reading too.
 *
 * ## Why the values are seeded from an effect
 *
 * The record resolves after the first render, so `defaultValues` cannot carry it — the same reason
 * the notifications screen seeds from an effect. Binding an input to `undefined` in the meantime
 * makes it uncontrolled, which React then complains about the moment the data arrives.
 *
 * ## A 404 is an empty form, not an error
 *
 * An organization that has never submitted has no record. The query does not retry and its failure
 * renders the blank form, because "you have not filled this in" and "this could not be loaded" look
 * identical to a user and only one of them has an action attached.
 */
const ENTITY_TYPE_LABELS: Readonly<Record<(typeof KYC_ENTITY_TYPES)[number], string>> = {
	"sole-proprietor": "Sole proprietor",
	partnership: "Partnership",
	"private-company": "Private company",
	"public-company": "Public company",
	"non-profit": "Non-profit",
	government: "Government",
};

const DECISION_LABELS: Readonly<Record<KycDecision, string>> = {
	pending: "Awaiting review",
	approved: "Approved",
	rejected: "Rejected",
	"needs-info": "More information needed",
};

/**
 * `needs-info` is a WARNING and not a danger, and the distinction is the whole point of the badge:
 * it is the one decision the tenant can act on, and painting it the same red as a rejection tells
 * somebody their application is over when a reviewer is waiting on them.
 */
const DECISION_TONES: Readonly<Record<KycDecision, BadgeTone>> = {
	pending: "neutral",
	approved: "success",
	rejected: "danger",
	"needs-info": "warning",
};

const EMPTY_FORM: KycFormValues = {
	legalEntityName: "",
	entityType: "private-company",
	taxId: "",
	addressLine1: "",
	addressLine2: "",
	addressCity: "",
	addressRegion: "",
	addressPostalCode: "",
	addressCountry: "",
	contactName: "",
	contactEmail: "",
	contactPhone: "",
	websiteUrl: "",
	expectedTrafficProfile: "",
	expectedMonthlyMinutes: "",
};

function formValuesFrom(record: KycRecord): KycFormValues {
	return {
		legalEntityName: record.legalEntityName,
		entityType: record.entityType,
		// Always blank. The stored id never comes back, and an empty box means "leave it alone".
		taxId: "",
		addressLine1: record.addressLine1,
		addressLine2: record.addressLine2 ?? "",
		addressCity: record.addressCity,
		addressRegion: record.addressRegion,
		addressPostalCode: record.addressPostalCode,
		addressCountry: record.addressCountry,
		contactName: record.contactName,
		contactEmail: record.contactEmail,
		contactPhone: record.contactPhone,
		websiteUrl: record.websiteUrl ?? "",
		expectedTrafficProfile: record.expectedTrafficProfile ?? "",
		expectedMonthlyMinutes:
			record.expectedMonthlyMinutes === null ? "" : String(record.expectedMonthlyMinutes),
	};
}

export function KycPanel() {
	const record = useKycRecord();
	const save = useKycRecordSave();
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: kycFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = kycFormSchema.parse(value);
			server.clear();
			try {
				await save.mutateAsync(parsed);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	const loaded = record.data;
	useEffect(() => {
		if (loaded) {
			form.reset(formValuesFrom(loaded));
		}
	}, [loaded, form]);

	if (record.isPending) {
		return (
			<Card>
				<CardBody className="p-0">
					<LoadingPanel label="Loading the compliance record" />
				</CardBody>
			</Card>
		);
	}

	const errors = server.errors;

	return (
		<div className="flex flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>
						<span className="flex flex-wrap items-center gap-2">
							Review status
							{loaded ? (
								<Badge tone={DECISION_TONES[loaded.decision]}>
									{DECISION_LABELS[loaded.decision]}
								</Badge>
							) : (
								<Badge tone="neutral">Not submitted</Badge>
							)}
						</span>
					</CardTitle>
					<CardDescription>
						{loaded
							? loaded.reviewedAt === null
								? "Nobody has looked at this yet."
								: `Last reviewed ${new Date(loaded.reviewedAt).toLocaleString()}.`
							: "Carriers ask who they are selling to before they will carry your traffic. Fill this in once; a reviewer decides on it."}
					</CardDescription>
				</CardHeader>
				{loaded?.reviewNotes ? (
					<CardBody>
						<p className="text-sm font-medium text-foreground">From the reviewer</p>
						<p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
							{loaded.reviewNotes}
						</p>
					</CardBody>
				) : null}
			</Card>

			<RequirePermission
				permissions={["compliance.write"]}
				fallback={
					<Card>
						<CardHeader>
							<CardTitle>Compliance record</CardTitle>
							<CardDescription>Your role can view this record but not change it.</CardDescription>
						</CardHeader>
						<CardBody className="space-y-1 text-sm text-foreground">
							<p>{loaded?.legalEntityName ?? "Nothing has been submitted yet."}</p>
							{loaded ? (
								<p className="text-muted-foreground">
									{ENTITY_TYPE_LABELS[loaded.entityType]} · {loaded.addressCity},{" "}
									{loaded.addressCountry}
								</p>
							) : null}
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
							<CardTitle>Legal entity</CardTitle>
							<CardDescription>
								As it appears on the registration or incorporation documents, not the trading name.
								Submitting a change sends the record back for review.
							</CardDescription>
						</CardHeader>
						<CardBody className="grid gap-5 sm:grid-cols-2">
							<form.Field name="legalEntityName">
								{(field) => (
									<TextField
										field={field}
										label="Legal entity name"
										required
										disabled={save.isPending}
										submitError={errors.legalEntityName}
										className="sm:col-span-2"
									/>
								)}
							</form.Field>
							<form.Field name="entityType">
								{(field) => (
									<SelectField
										field={field}
										label="Entity type"
										disabled={save.isPending}
										submitError={errors.entityType}
									>
										{KYC_ENTITY_TYPES.map((value) => (
											<option key={value} value={value}>
												{ENTITY_TYPE_LABELS[value]}
											</option>
										))}
									</SelectField>
								)}
							</form.Field>
							<form.Field name="taxId">
								{(field) => (
									<TextField
										field={field}
										label="Tax ID"
										description={
											loaded?.taxIdLast4
												? `Ending ${loaded.taxIdLast4} is on file. Leave this empty to keep it.`
												: "Stored encrypted. It is never shown again once saved."
										}
										disabled={save.isPending}
										submitError={errors.taxId}
									/>
								)}
							</form.Field>

							<form.Field name="addressLine1">
								{(field) => (
									<TextField
										field={field}
										label="Address"
										required
										disabled={save.isPending}
										submitError={errors.addressLine1}
										className="sm:col-span-2"
									/>
								)}
							</form.Field>
							<form.Field name="addressLine2">
								{(field) => (
									<TextField
										field={field}
										label="Address line 2"
										disabled={save.isPending}
										submitError={errors.addressLine2}
										className="sm:col-span-2"
									/>
								)}
							</form.Field>
							<form.Field name="addressCity">
								{(field) => (
									<TextField
										field={field}
										label="City"
										required
										disabled={save.isPending}
										submitError={errors.addressCity}
									/>
								)}
							</form.Field>
							<form.Field name="addressRegion">
								{(field) => (
									<TextField
										field={field}
										label="State or region"
										required
										disabled={save.isPending}
										submitError={errors.addressRegion}
									/>
								)}
							</form.Field>
							<form.Field name="addressPostalCode">
								{(field) => (
									<TextField
										field={field}
										label="Postal code"
										required
										disabled={save.isPending}
										submitError={errors.addressPostalCode}
									/>
								)}
							</form.Field>
							<form.Field name="addressCountry">
								{(field) => (
									<TextField
										field={field}
										label="Country"
										required
										placeholder="US"
										description="Two-letter code."
										disabled={save.isPending}
										submitError={errors.addressCountry}
									/>
								)}
							</form.Field>

							<form.Field name="contactName">
								{(field) => (
									<TextField
										field={field}
										label="Contact name"
										required
										description="Who a reviewer or a traceback reaches."
										disabled={save.isPending}
										submitError={errors.contactName}
									/>
								)}
							</form.Field>
							<form.Field name="contactEmail">
								{(field) => (
									<TextField
										field={field}
										label="Contact email"
										type="email"
										required
										disabled={save.isPending}
										submitError={errors.contactEmail}
									/>
								)}
							</form.Field>
							<form.Field name="contactPhone">
								{(field) => (
									<TextField
										field={field}
										label="Contact phone"
										required
										placeholder="+15551234567"
										disabled={save.isPending}
										submitError={errors.contactPhone}
									/>
								)}
							</form.Field>
							<form.Field name="websiteUrl">
								{(field) => (
									<TextField
										field={field}
										label="Website"
										placeholder="https://example.com"
										disabled={save.isPending}
										submitError={errors.websiteUrl}
									/>
								)}
							</form.Field>

							<form.Field name="expectedMonthlyMinutes">
								{(field) => (
									<TextField
										field={field}
										label="Expected monthly minutes"
										description="An estimate. A reviewer reads it against what actually happens."
										disabled={save.isPending}
										submitError={errors.expectedMonthlyMinutes}
									/>
								)}
							</form.Field>
							<form.Field name="expectedTrafficProfile">
								{(field) => (
									<TextareaField
										field={field}
										label="What these calls are"
										description="Who you call and why — appointment reminders, support callbacks, outbound sales. This is the answer a carrier compares a traceback against."
										rows={3}
										disabled={save.isPending}
										submitError={errors.expectedTrafficProfile}
										className="sm:col-span-2"
									/>
								)}
							</form.Field>
						</CardBody>
						<CardFooter>
							<Button type="submit" variant="primary" loading={save.isPending}>
								Submit for review
							</Button>
						</CardFooter>
					</form>
				</Card>
			</RequirePermission>
		</div>
	);
}
