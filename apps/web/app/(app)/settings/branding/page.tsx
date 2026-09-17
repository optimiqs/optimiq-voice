"use client";

import { useForm, useStore } from "@tanstack/react-form";
import { useTheme } from "next-themes";
import { useEffect, type CSSProperties } from "react";
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
import { DEFAULT_BRANDING } from "~/lib/branding/contracts";
import {
	brandingFormSchema,
	brandingToForm,
	EMPTY_BRANDING_FORM,
	formToBrandingPatch,
} from "~/lib/branding/schemas";
import { deriveBrandRoles, isHexColor } from "~/lib/branding/theme";
import { RequirePermission } from "../../_components/require-permission";
import { useBranding, useSaveBranding } from "../../_hooks/use-branding-queries";
import { SettingsNav } from "../_components/settings-nav";
import { BrandingLogoField } from "./_components/logo-field";

/**
 * The white-label branding screen.
 *
 * Matches the notifications/routing settings pattern exactly — `@tanstack/react-form` with a Zod
 * validator, values seeded from an effect once the read resolves, one card, save gated by
 * `settings.write` with a read-only fallback. What it adds is a LIVE preview: the same
 * `deriveBrandRoles` the app's theme layer uses, applied as custom properties on a preview box so
 * an administrator sees the actual primary/accent the app will render before they save.
 */
export default function BrandingSettingsPage() {
	const branding = useBranding();
	const save = useSaveBranding();
	const { resolvedTheme } = useTheme();

	const form = useForm({
		defaultValues: EMPTY_BRANDING_FORM,
		validators: { onSubmit: brandingFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = brandingFormSchema.parse(value);
			await save.mutateAsync(formToBrandingPatch(parsed));
		},
	});

	const loaded = branding.data;
	useEffect(() => {
		if (loaded) {
			form.reset(brandingToForm(loaded));
		}
	}, [loaded, form]);

	// Live preview: read the current field values and derive the theme they would apply.
	const values = useStore(form.store, (state) => state.values);
	const primaryValid = values.primaryColor === "" || isHexColor(values.primaryColor);
	// The roles go on the preview box itself as custom properties. Scoping is then STRUCTURAL — the
	// half-typed theme cannot bleed onto the live app because it never leaves this element — rather
	// than a rewrite of another module's stylesheet text, which breaks the moment that module emits
	// a selector the rewrite does not know about.
	const roles = deriveBrandRoles(formToBrandingPatch(values));
	const previewVars = resolvedTheme === "dark" ? roles.dark : roles.light;

	return (
		<>
			<PageHeader
				title="Branding"
				description="Your product name, logo and colours. These replace the defaults across the app and on the sign-in page."
			/>
			<SettingsNav />

			{branding.isPending && !loaded ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading branding" />
					</CardBody>
				</Card>
			) : (
				<RequirePermission
					permissions={["branding.write"]}
					fallback={
						<Card>
							<CardHeader>
								<CardTitle>Branding</CardTitle>
								<CardDescription>Your role can view branding but not change it.</CardDescription>
							</CardHeader>
							<CardBody className="space-y-2 text-sm text-foreground">
								<p>Product name: {loaded?.productName}</p>
								<p className="text-muted-foreground">
									Primary colour: {loaded?.primaryColor ?? "the built-in default"}
								</p>
							</CardBody>
						</Card>
					}
				>
					<div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
						<Card>
							<form
								noValidate
								onSubmit={(event) => {
									event.preventDefault();
									void form.handleSubmit();
								}}
							>
								<CardHeader>
									<CardTitle>White-label</CardTitle>
									<CardDescription>
										Colours are hex like <span data-tabular>#2f6fed</span>. Leave any field empty to
										use the built-in default.
									</CardDescription>
								</CardHeader>
								<CardBody className="space-y-5">
									<form.Field name="productName">
										{(field) => (
											<TextField
												field={field}
												label="Product name"
												description="Shown in the app, the sign-in lockup and the browser tab."
												required
												disabled={save.isPending}
												className="max-w-md"
											/>
										)}
									</form.Field>

									{/*
									 * The logo is its OWN write, not a field on this form: the upload endpoint
									 * stores the bytes and points the branding row at the key it minted, in one
									 * request, and returns the re-resolved brand. So it sits inside the card and
									 * outside the form's submit — see `_components/logo-field.tsx`.
									 */}
									<BrandingLogoField brand={loaded ?? DEFAULT_BRANDING} />

									<div className="grid gap-5 sm:grid-cols-2">
										<form.Field name="primaryColor">
											{(field) => (
												<TextField
													field={field}
													label="Primary colour"
													description="Buttons, links and the focus ring."
													placeholder="#2f6fed"
													disabled={save.isPending}
												/>
											)}
										</form.Field>
										<form.Field name="accentColor">
											{(field) => (
												<TextField
													field={field}
													label="Accent colour"
													description="Selected states. Defaults to the primary hue."
													placeholder="#2f6fed"
													disabled={save.isPending}
												/>
											)}
										</form.Field>
									</div>

									<form.Field name="supportEmail">
										{(field) => (
											<TextField
												field={field}
												label="Support email"
												type="email"
												description="Where “contact support” links point."
												disabled={save.isPending}
												className="max-w-md"
											/>
										)}
									</form.Field>

									<div className="grid gap-5 sm:grid-cols-2">
										<form.Field name="customDomain">
											{(field) => (
												<TextField
													field={field}
													label="Custom domain"
													description="The host the sign-in page is served from, for the public by-host read."
													placeholder="voice.acme.com"
													disabled={save.isPending}
												/>
											)}
										</form.Field>
										<form.Field name="defaultLanguage">
											{(field) => (
												<TextField
													field={field}
													label="Default language"
													description="A BCP-47 tag like en or en-GB."
													placeholder="en"
													disabled={save.isPending}
												/>
											)}
										</form.Field>
									</div>
								</CardBody>
								<CardFooter>
									<Button type="submit" variant="primary" loading={save.isPending}>
										Save branding
									</Button>
								</CardFooter>
							</form>
						</Card>

						{/* Live preview — the real theme roles, applied to this box and nowhere else. */}
						<Card className="h-fit">
							<CardHeader>
								<CardTitle>Preview</CardTitle>
								<CardDescription>The colours as the app will render them.</CardDescription>
							</CardHeader>
							<CardBody>
								<div
									style={previewVars as CSSProperties}
									className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-4"
								>
									<span className="text-sm font-medium text-foreground">
										{values.productName || "Optimiq Voice"}
									</span>
									<button
										type="button"
										className="inline-flex h-9 items-center justify-center rounded-field bg-primary px-4 text-sm text-primary-foreground hover:bg-primary-hover"
									>
										Primary button
									</button>
									<span className="inline-flex w-fit items-center rounded-field bg-accent px-2 py-1 text-xs text-accent-foreground">
										Selected
									</span>
									{!primaryValid ? (
										<p className="text-xs text-muted-foreground">
											Enter a valid hex colour to preview the primary.
										</p>
									) : null}
								</div>
							</CardBody>
						</Card>
					</div>
				</RequirePermission>
			)}
		</>
	);
}
