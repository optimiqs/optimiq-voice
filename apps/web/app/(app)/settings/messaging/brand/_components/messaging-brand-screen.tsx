"use client";

import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";
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
import { Input } from "~/components/ui/field";
import { SelectField, TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { messagingErrorBody } from "~/lib/messaging/errors";
import { relativeTime } from "~/lib/messaging/format";
import { brandSchema, type BrandForm } from "~/lib/messaging/schemas";
import { RequirePermission } from "../../../../_components/require-permission";
import {
	useBrands,
	useSaveBrand,
	useSendBrandOtp,
	useVerifyBrandOtp,
} from "../../../../_hooks/use-messaging-queries";
import { SettingsNav } from "../../../_components/settings-nav";
import { MessagingSettingsNav } from "../../_components/messaging-settings-nav";
import type { BrandRow, BrandStatus } from "~/lib/messaging/contracts";

/**
 * The 10DLC brand — who this organization IS, as far as the carriers are concerned.
 *
 * ## One brand, edited in place
 *
 * The endpoint is a collection because the registry's model is, not because a tenant is expected to
 * hold several: a brand is tied to a legal entity, and this platform's tenant IS that entity. So
 * the form edits the first row and creates one when there is none, and there is no list.
 *
 * ## The status panel is the whole reason this page is worth opening twice
 *
 * A brand is submitted once and then waits. `status`, `statusReason` and the last poll time are the
 * three facts somebody coming back a day later wants, and `lastPolledAt` is the one that stops the
 * other two being misread: "rejected, as of never checked" and "rejected, checked a minute ago"
 * are different situations.
 *
 * ## Sole proprietors, and the PIN round trip
 *
 * A sole proprietor has no EIN, so the registry verifies them by texting a PIN to the contact
 * number instead. The two controls for that appear only for that entity type — showing a "send
 * PIN" button to a corporation would be an action that cannot succeed — and the EIN field
 * disappears at the same moment, because asking a sole trader for a number they do not have is how
 * a form teaches somebody to type nonsense into it.
 */

const ENTITY_TYPE_LABELS: Readonly<Record<string, string>> = {
	PRIVATE_PROFIT: "Private company",
	PUBLIC_PROFIT: "Publicly traded company",
	NON_PROFIT: "Non-profit",
	GOVERNMENT: "Government",
	SOLE_PROPRIETOR: "Sole proprietor",
};

const EMPTY_FORM: BrandForm = {
	displayName: "",
	companyName: "",
	entityType: "PRIVATE_PROFIT",
	ein: "",
	vertical: "",
	contactEmail: "",
	contactPhone: "",
	website: "",
	street: "",
	city: "",
	state: "",
	postalCode: "",
	country: "US",
};

export function MessagingBrandScreen() {
	const { query, brand } = useBrands();
	const save = useSaveBrand();
	const serverErrors = useServerFieldErrors();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: brandSchema },
		onSubmit: async ({ value }) => {
			const parsed = brandSchema.parse(value);
			serverErrors.clear();
			try {
				await save.mutateAsync({
					id: brand?.id,
					values: {
						displayName: parsed.displayName,
						companyName: parsed.companyName,
						entityType: parsed.entityType,
						// A sole proprietor has no EIN, and a strict body must not carry an empty one.
						...(parsed.entityType === "SOLE_PROPRIETOR" ? {} : { ein: parsed.ein }),
						vertical: parsed.vertical,
						contactEmail: parsed.contactEmail,
						contactPhone: parsed.contactPhone,
						website: parsed.website.length === 0 ? null : parsed.website,
						street: parsed.street,
						city: parsed.city,
						state: parsed.state,
						postalCode: parsed.postalCode,
						country: parsed.country.toUpperCase(),
					},
				});
			} catch (error) {
				serverErrors.capture(error);
				throw error;
			}
		},
	});

	const loaded = brand;
	useEffect(() => {
		if (loaded) {
			form.reset({
				displayName: loaded.displayName,
				companyName: loaded.companyName,
				entityType: loaded.entityType,
				ein: loaded.ein ?? "",
				vertical: loaded.vertical,
				contactEmail: loaded.contactEmail,
				contactPhone: loaded.contactPhone,
				website: loaded.website ?? "",
				street: loaded.street,
				city: loaded.city,
				state: loaded.state,
				postalCode: loaded.postalCode,
				country: loaded.country,
			});
		}
	}, [loaded, form]);

	return (
		<>
			<PageHeader
				title="10DLC brand"
				description="Who this organization is, as the carriers see it. Every local number's campaign is registered against this brand, so it has to be filed before any local number can send."
			/>
			<SettingsNav />
			<MessagingSettingsNav />

			{query.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading brand" />
					</CardBody>
				</Card>
			) : (
				<>
					{brand ? <BrandStatusPanel brand={brand} /> : null}

					<RequirePermission
						permissions={["messaging.manage"]}
						fallback={
							<Card>
								<CardHeader>
									<CardTitle>Brand details</CardTitle>
									<CardDescription>
										Your role can see this organization&rsquo;s registration status but not file or
										change it.
									</CardDescription>
								</CardHeader>
								<CardBody className="space-y-1 text-sm text-foreground">
									<p>{brand?.companyName ?? "No brand has been filed yet."}</p>
									{brand ? (
										<p className="text-muted-foreground">
											{ENTITY_TYPE_LABELS[brand.entityType] ?? brand.entityType} · {brand.vertical}
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
									<CardTitle>Brand details</CardTitle>
									<CardDescription>
										These go to the campaign registry as filed. A name or an address that does not
										match the company&rsquo;s public record is the most common reason a brand is
										rejected.
									</CardDescription>
								</CardHeader>
								<CardBody className="grid gap-5 md:grid-cols-2">
									<form.Field name="displayName">
										{(field) => (
											<TextField
												field={field}
												label="Display name"
												required
												description="The name recipients see attributed to your messages."
												submitError={serverErrors.errors.displayName}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="companyName">
										{(field) => (
											<TextField
												field={field}
												label="Legal company name"
												required
												description="Exactly as it appears on the registration."
												submitError={serverErrors.errors.companyName}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="entityType">
										{(field) => (
											<SelectField
												field={field}
												label="Entity type"
												required
												submitError={serverErrors.errors.entityType}
												disabled={save.isPending}
											>
												{Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => (
													<option key={value} value={value}>
														{label}
													</option>
												))}
											</SelectField>
										)}
									</form.Field>

									<form.Subscribe selector={(state) => state.values.entityType}>
										{(entityType) =>
											entityType === "SOLE_PROPRIETOR" ? (
												<p className="self-end text-xs text-muted-foreground">
													A sole proprietor has no EIN. The registry verifies you by texting a PIN
													to the contact number below instead.
												</p>
											) : (
												<form.Field name="ein">
													{(field) => (
														<TextField
															field={field}
															label="EIN"
															required
															description="The nine-digit employer identification number."
															submitError={serverErrors.errors.ein}
															disabled={save.isPending}
														/>
													)}
												</form.Field>
											)
										}
									</form.Subscribe>

									<form.Field name="vertical">
										{(field) => (
											<TextField
												field={field}
												label="Vertical"
												required
												description="The industry the registry files you under — retail, healthcare, education."
												submitError={serverErrors.errors.vertical}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="website">
										{(field) => (
											<TextField
												field={field}
												label="Website"
												type="url"
												description="Optional, and checked against the company name when it is given."
												submitError={serverErrors.errors.website}
												disabled={save.isPending}
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
												submitError={serverErrors.errors.contactEmail}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="contactPhone">
										{(field) => (
											<TextField
												field={field}
												label="Contact phone"
												type="tel"
												required
												description="A sole proprietor's PIN is sent to this number."
												submitError={serverErrors.errors.contactPhone}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="street">
										{(field) => (
											<TextField
												field={field}
												label="Street"
												required
												submitError={serverErrors.errors.street}
												disabled={save.isPending}
												className="md:col-span-2"
											/>
										)}
									</form.Field>

									<form.Field name="city">
										{(field) => (
											<TextField
												field={field}
												label="City"
												required
												submitError={serverErrors.errors.city}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="state">
										{(field) => (
											<TextField
												field={field}
												label="State or province"
												required
												submitError={serverErrors.errors.state}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="postalCode">
										{(field) => (
											<TextField
												field={field}
												label="Postal code"
												required
												submitError={serverErrors.errors.postalCode}
												disabled={save.isPending}
											/>
										)}
									</form.Field>

									<form.Field name="country">
										{(field) => (
											<TextField
												field={field}
												label="Country"
												required
												description="Two-letter code — US, not USA."
												submitError={serverErrors.errors.country}
												disabled={save.isPending}
											/>
										)}
									</form.Field>
								</CardBody>
								<CardFooter>
									<Button type="submit" variant="primary" loading={save.isPending}>
										{brand ? "Save and resubmit" : "Submit brand"}
									</Button>
								</CardFooter>
							</form>
						</Card>

						{brand && brand.entityType === "SOLE_PROPRIETOR" ? (
							<SoleProprietorOtp brand={brand} />
						) : null}
					</RequirePermission>
				</>
			)}
		</>
	);
}

const BRAND_STATUS_TONE: Readonly<
	Record<BrandStatus, "success" | "warning" | "danger" | "neutral">
> = {
	verified: "success",
	pending: "warning",
	rejected: "danger",
	unsubmitted: "neutral",
};

/**
 * Status, the registry's reason, and when we last asked.
 *
 * The poll time is not decoration. A brand's status is a cached answer from somebody else's system,
 * and "rejected — last checked four days ago" is a different instruction from "rejected — last
 * checked a minute ago": the first says go and look, the second says go and fix.
 */
function BrandStatusPanel({ brand }: { brand: BrandRow }) {
	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between gap-3">
				<div className="flex flex-col gap-1">
					<CardTitle>Registration status</CardTitle>
					<CardDescription>
						Filed with the campaign registry. Nothing on this page changes what the carriers have
						already decided — a rejection has to be fixed and resubmitted.
					</CardDescription>
				</div>
				<Badge tone={BRAND_STATUS_TONE[brand.status]}>{brand.status}</Badge>
			</CardHeader>
			<CardBody className="space-y-2 text-sm">
				{brand.statusReason ? (
					<p className="text-foreground">{brand.statusReason}</p>
				) : (
					<p className="text-muted-foreground">
						The registry has not attached a reason to this status.
					</p>
				)}
				<p className="text-xs text-muted-foreground" data-tabular>
					{brand.lastPolledAt
						? `Last checked ${relativeTime(brand.lastPolledAt)} ago — ${new Date(brand.lastPolledAt).toLocaleString()}`
						: "This platform has not yet checked the registry for an update."}
				</p>
			</CardBody>
		</Card>
	);
}

/**
 * The SMS one-time PIN, for a sole proprietor.
 *
 * Two steps and two buttons, in the order they happen: send, then enter. The PIN field is present
 * from the start rather than revealed by the send, because a PIN arrives on a PHONE — the person
 * typing it may well have requested it on the last visit, or on somebody else's screen, and hiding
 * the field until this browser has pressed "send" would make an arrived PIN unusable.
 */
function SoleProprietorOtp({ brand }: { brand: BrandRow }) {
	const sendOtp = useSendBrandOtp();
	const verifyOtp = useVerifyBrandOtp();
	const [pin, setPin] = useState("");

	const verifyFailure = verifyOtp.isError
		? (messagingErrorBody(verifyOtp.error)?.message ??
			"That PIN was not accepted. Check the code and try again, or send a new one.")
		: undefined;

	if (brand.otpVerifiedAt !== null) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Identity verified</CardTitle>
					<CardDescription>
						The PIN was confirmed on {new Date(brand.otpVerifiedAt).toLocaleString()}. Nothing
						further is needed here.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Verify by text message</CardTitle>
				<CardDescription>
					A sole proprietor is verified by PIN rather than by EIN. The registry texts a code to{" "}
					{brand.contactPhone}; enter it below to finish the registration.
				</CardDescription>
			</CardHeader>
			<CardBody className="flex flex-wrap items-end gap-3">
				<Button
					variant="secondary"
					loading={sendOtp.isPending}
					onClick={() => sendOtp.mutate(brand.id)}
				>
					{brand.otpPending ? "Send a new PIN" : "Send PIN"}
				</Button>

				<div className="flex flex-col gap-1.5">
					<label htmlFor="brand-otp-pin" className="text-sm font-medium text-foreground">
						PIN
					</label>
					<Input
						id="brand-otp-pin"
						inputMode="numeric"
						autoComplete="one-time-code"
						value={pin}
						onChange={(event) => setPin(event.target.value)}
						className="w-40"
						aria-invalid={verifyFailure ? true : undefined}
						aria-describedby={verifyFailure ? "brand-otp-error" : undefined}
					/>
				</div>

				<Button
					variant="primary"
					loading={verifyOtp.isPending}
					disabled={pin.trim().length < 4}
					onClick={() =>
						verifyOtp.mutate({ id: brand.id, pin: pin.trim() }, { onSuccess: () => setPin("") })
					}
				>
					Verify PIN
				</Button>

				{verifyFailure ? (
					<p id="brand-otp-error" role="alert" className="w-full text-xs text-danger">
						{verifyFailure}
					</p>
				) : null}
			</CardBody>
		</Card>
	);
}
