"use client";

import { useForm } from "@tanstack/react-form";
import { useEffect, useMemo } from "react";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
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
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { changedSettings } from "~/lib/org-settings/client";
import {
	EMPTY_ROUTING_FORM,
	fromRoutingFormValues,
	routingSettingsFormSchema,
	timezoneOptions,
	toRoutingFormValues,
} from "~/lib/org-settings/routing-form";
import { RequirePermission } from "../../_components/require-permission";
import { useRoutingSettings, useSaveRoutingSettings } from "../../_hooks/use-org-settings-queries";
import { SettingsNav } from "../_components/settings-nav";
import { HangupCausesField } from "./_components/hangup-causes-field";
import type { FieldLike } from "~/components/ui/form-fields";
import type { RoutingSettings } from "~/lib/org-settings/client";

/**
 * The `routing` category of the settings cascade — the eight names the routing compiler reads.
 *
 * ## Everything here is live configuration, and the page says so before the first control
 *
 * `affectsRouting("org_setting")` is true, so a save recompiles the tenant's artifact and
 * republishes it inside the same request. There is no draft, no separate publish step, and no
 * moment where the screen and the switch disagree — which is exactly why the banner at the top is
 * not decoration. The same property has a second edge: a save the compiler refuses is ROLLED BACK
 * rather than stored, so a failure here means nothing changed, and the error toast says that
 * rather than "saved with problems".
 *
 * ## Why this form sends a diff and the notifications form does not
 *
 * See `changedSettings`. In short: `readRoutingSettings` treats an ABSENT `trunkContinueOnCauses`
 * row as "use the platform's built-in retryable set" and a row holding `[]` as "retry nothing",
 * while `GET …/categories/routing` resolves both to `[]`. A form that PATCHed all eight keys would
 * turn trunk failover off for the whole organization the first time anybody pressed Save on this
 * page, with nothing on screen changing to show it. Sending only what was touched is what keeps an
 * untouched setting untouched, and it is why Save is disabled until something differs.
 *
 * ## Why the values are seeded from an effect
 *
 * The category query resolves after the first render, the same as on the notifications screen, so
 * `defaultValues` cannot carry the tenant's values. `form.reset(...)` also re-bases what "changed"
 * means, which is what makes Save go quiet again after a successful write.
 */

const NO_CHANGES: Readonly<Record<string, unknown>> = {};

/**
 * The field copy, hoisted out of the JSX because several of these sentences are the only place a
 * consequence is written down — the kill switch's blast radius, and what an EMPTY cause list
 * actually means — and a paragraph buried in a prop is a paragraph nobody edits.
 */
const COPY = {
	live:
		"Saving here recompiles this organization's routing and republishes it to the engine — " +
		"there is no separate publish step, and the next call uses what you save. A change the " +
		"compiler cannot accept is rolled back rather than stored.",
	timezone:
		"What a time condition is evaluated in when it does not carry a zone of its own. An " +
		"unknown zone fails the compile, so this is a list rather than a text box.",
	voicemailPrefix:
		"Dialled before an extension to reach its greeting directly, e.g. *99. Empty disables the " +
		"internal voicemail-prefix table.",
	voicemailCheckPrefix:
		"Dialled before a mailbox number to log into it, e.g. *98. Empty disables it.",
	outboundEnabled:
		"The organization-wide kill switch. Off means no call reaches an outbound route at all, " +
		"whatever the routes and extensions say.",
	callerIdNumber:
		"Presented when neither the outbound route nor the extension supplies one. E.164, e.g. " +
		"+12125550100.",
	callerIdName:
		"The display name presented when nothing more specific supplies one. Whether it survives " +
		"the carrier is the carrier's decision.",
	causes:
		"Which failures let an outbound dial continue to the next trunk. Left untouched, the " +
		"platform's built-in retryable set applies. Saving with nothing selected stores an empty " +
		"list, which means a dial stops at its first trunk. Never select a cause that is the far " +
		"end's decision — retrying a rejection on every trunk is how toll-fraud loops start.",
	emergencyNumbers:
		"Recognised as emergency calls in addition to the built-in set — for a site that also " +
		"needs 112, 999 or an internal security number. One per line, or separated by commas. At " +
		"most 32.",
} as const;

export default function RoutingSettingsPage() {
	const settings = useRoutingSettings();
	const save = useSaveRoutingSettings();
	const loaded = settings.data;

	const form = useForm({
		defaultValues: EMPTY_ROUTING_FORM,
		validators: { onSubmit: routingSettingsFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = routingSettingsFormSchema.parse(value);
			const next = fromRoutingFormValues(parsed);
			await save.mutateAsync(changedSettings(loaded ?? next, next));
			// Re-base the form on what was just written, so Save goes quiet until the next edit.
			form.reset(toRoutingFormValues(next));
		},
	});

	useEffect(() => {
		if (loaded) {
			form.reset(toRoutingFormValues(loaded));
		}
	}, [loaded, form]);

	return (
		<>
			<PageHeader
				title="Routing"
				description="The organization-wide defaults every call is compiled against."
			/>
			<SettingsNav />

			{settings.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading routing settings" />
					</CardBody>
				</Card>
			) : (
				<RequirePermission
					permissions={["settings.write"]}
					fallback={<ReadOnlyView settings={loaded} />}
				>
					<form
						noValidate
						className="flex flex-col gap-6"
						onSubmit={(event) => {
							event.preventDefault();
							void form.handleSubmit();
						}}
					>
						<NoticeBanner title="Changes are live immediately" description={COPY.live} />

						<Card>
							<CardHeader>
								<CardTitle>Dial plan</CardTitle>
								<CardDescription>
									What the compiler falls back to when a route, a time condition or an extension
									does not say.
								</CardDescription>
							</CardHeader>
							<CardBody className="space-y-5">
								<form.Field name="defaultTimezone">
									{(field) => <TimezoneField field={field} disabled={save.isPending} />}
								</form.Field>

								<form.Field name="voicemailPrefix">
									{(field) => (
										<TextField
											field={field}
											label="Voicemail transfer prefix"
											description={COPY.voicemailPrefix}
											placeholder="*99"
											disabled={save.isPending}
											className="max-w-md"
										/>
									)}
								</form.Field>

								<form.Field name="voicemailCheckPrefix">
									{(field) => (
										<TextField
											field={field}
											label="Voicemail check prefix"
											description={COPY.voicemailCheckPrefix}
											placeholder="*98"
											disabled={save.isPending}
											className="max-w-md"
										/>
									)}
								</form.Field>
							</CardBody>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Outbound calling</CardTitle>
								<CardDescription>
									The organization's own caller identity, and how far a failed dial is allowed to
									retry.
								</CardDescription>
							</CardHeader>
							<CardBody className="space-y-5">
								<form.Field name="outboundEnabled">
									{(field) => (
										<SwitchField
											field={field}
											label="Allow outbound calls"
											description={COPY.outboundEnabled}
											disabled={save.isPending}
										/>
									)}
								</form.Field>

								<form.Field name="outboundCallerIdNumber">
									{(field) => (
										<TextField
											field={field}
											label="Outbound caller ID number"
											type="tel"
											description={COPY.callerIdNumber}
											placeholder="+12125550100"
											disabled={save.isPending}
											className="max-w-md"
										/>
									)}
								</form.Field>

								<form.Field name="outboundCallerIdName">
									{(field) => (
										<TextField
											field={field}
											label="Outbound caller ID name"
											description={COPY.callerIdName}
											placeholder="Acme Corp"
											disabled={save.isPending}
											className="max-w-md"
										/>
									)}
								</form.Field>

								<form.Field name="trunkContinueOnCauses">
									{(field) => (
										<HangupCausesField
											field={field}
											label="Retryable hangup causes"
											description={COPY.causes}
											disabled={save.isPending}
										/>
									)}
								</form.Field>
							</CardBody>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Emergency dialling</CardTitle>
								<CardDescription>
									Additive only. No setting on this page can remove 911 or the rest of the
									compiled-in NANP set from the dial plan.
								</CardDescription>
							</CardHeader>
							<CardBody className="space-y-5">
								<form.Field name="emergencyNumbers">
									{(field) => (
										<TextareaField
											field={field}
											label="Additional emergency numbers"
											description={COPY.emergencyNumbers}
											placeholder={"112\n999"}
											rows={3}
											disabled={save.isPending}
											className="max-w-md"
										/>
									)}
								</form.Field>
							</CardBody>
							<CardFooter className="justify-between gap-4">
								<form.Subscribe selector={(state) => state.values}>
									{(values) => {
										const patch = loaded
											? changedSettings(loaded, fromRoutingFormValues(values))
											: NO_CHANGES;
										const count = Object.keys(patch).length;
										return (
											<>
												<p className="text-xs text-muted-foreground">
													{count === 0
														? "No unsaved changes."
														: `${count} setting${count === 1 ? "" : "s"} changed — saving recompiles routing.`}
												</p>
												<Button
													type="submit"
													variant="primary"
													loading={save.isPending}
													disabled={count === 0}
												>
													Save and recompile
												</Button>
											</>
										);
									}}
								</form.Subscribe>
							</CardFooter>
						</Card>
					</form>
				</RequirePermission>
			)}
		</>
	);
}

/**
 * `defaultTimezone`, as a select over the runtime's own zone list.
 *
 * Split out because the option list is ~400 entries and rebuilding it on every keystroke elsewhere
 * in the form is work nobody asked for; `useMemo` keyed on the current value is enough because the
 * only reason the list changes is a stored zone the runtime does not know about.
 */
function TimezoneField({ field, disabled }: { field: FieldLike<string>; disabled?: boolean }) {
	const current = field.state.value;
	const zones = useMemo(() => timezoneOptions(current), [current]);

	return (
		<SelectField
			field={field}
			label="Default time zone"
			description={COPY.timezone}
			disabled={disabled}
			className="max-w-md"
		>
			{zones.map((zone) => (
				<option key={zone} value={zone}>
					{zone}
				</option>
			))}
		</SelectField>
	);
}

/**
 * What a role with `settings.read` and no `settings.write` sees.
 *
 * The facts, not a disabled copy of the form: a greyed-out control invites someone to try to
 * change it and says nothing about what the value means. The two that decide whether calls leave
 * the building at all come first.
 */
function ReadOnlyView({ settings }: { settings: RoutingSettings | undefined }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Routing</CardTitle>
				<CardDescription>Your role can view these settings but not change them.</CardDescription>
			</CardHeader>
			<CardBody className="space-y-2 text-sm text-foreground">
				<p>Outbound calling is {settings?.outboundEnabled ? "on" : "off"} for this organization.</p>
				<p className="text-muted-foreground">
					Default time zone: {settings?.defaultTimezone ?? "UTC"}
				</p>
				<p className="text-muted-foreground">
					Outbound caller ID:{" "}
					{settings?.outboundCallerIdNumber ?? "whatever the route or extension supplies"}
				</p>
				<p className="text-muted-foreground">
					Additional emergency numbers:{" "}
					{settings && settings.emergencyNumbers.length > 0
						? settings.emergencyNumbers.join(", ")
						: "none beyond the built-in set"}
				</p>
			</CardBody>
		</Card>
	);
}
