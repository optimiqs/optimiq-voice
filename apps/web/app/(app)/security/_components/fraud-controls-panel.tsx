"use client";

import { useForm } from "@tanstack/react-form";
import { useEffect } from "react";
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
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { LoadingPanel } from "~/components/ui/spinner";
import { countryLabel, regionDisplayNames } from "~/lib/toll-fraud/countries";
import {
	changedPolicyKeys,
	EMPTY_TOLL_FRAUD_POLICY_FORM,
	fromPolicyFormValues,
	policyToWrite,
	toPolicyFormValues,
	tollFraudPolicyFormSchema,
} from "~/lib/toll-fraud/policy-form";
import { RequirePermission } from "../../_components/require-permission";
import {
	useSaveTollFraudPolicy,
	useTollFraudPolicy,
	useTollFraudUsage,
} from "../../_hooks/use-toll-fraud-queries";
import { CountryListField } from "./country-list-field";
import type { TollFraudPolicy, TollFraudUsage } from "~/lib/toll-fraud/client";

/**
 * The organization's toll-fraud policy — `/api/v1/toll-fraud`.
 *
 * ## Why a tab of `/security` rather than `/settings/security`
 *
 * The settings screens edit the org-settings CASCADE: a category of catalogued names, PATCHed as a
 * partial `{ name: value }` object. This is not that — it is a table of its own with a `PUT` and a
 * `toll-fraud.*` grant nobody holding `settings.write` necessarily has — so a `/settings/*` route
 * would put a page under a sidebar entry whose `PAGE_PERMISSIONS` entry could not describe it.
 *
 * `/security` is the right neighbour for the reason the two existing tabs are neighbours: the auth
 * failure log is how somebody finds out a credential leaked, and this is the screen where they cap
 * what the leak can spend. Two routes would put the evidence and the control one navigation apart.
 * Its grants differ from the tab beside it (`toll-fraud.read` against `security.read`), so it gates
 * itself rather than riding the route's entry — the precedent the media page's phrases tab set.
 *
 * ## Saving sends the WHOLE policy
 *
 * `PUT` means the body is the complete set of controls: a ceiling left out is a ceiling REMOVED.
 * That is the API's decision and a good one — it makes "clear this limit" and "leave this limit
 * alone" different requests — but it means the diff-only rule the routing settings screen follows
 * does not apply here. `changedPolicyKeys` is used for the footer's count and to keep Save quiet,
 * never to build the request.
 */

const COPY = {
	live:
		"These limits are enforced on the next international call — by this API when a call is " +
		"placed through it, and by the engine at dial time from the same published policy. There is " +
		"no separate publish step.",
	unconstrained:
		"This organization has no fraud policy yet, so international calling is unconstrained. " +
		"Saving this form creates one.",
	enabled:
		"The master switch. Off means none of the limits below are applied, and a compromised " +
		"extension can dial anywhere this organization's toll classes allow.",
	concurrent:
		"How many international calls may be up at once. Empty means no limit. Zero refuses every " +
		"international call, which is how a tenant is stopped without editing anybody's toll class.",
	minutesHour:
		"International minutes in any rolling hour. This is the ceiling that catches a burst — a " +
		"stolen credential dialling continuously reaches it in under an hour.",
	minutesDay:
		"International minutes in any rolling day. The slower ceiling, for a leak metered to stay " +
		"under the hourly one.",
	allowed:
		"When set, international calls reach ONLY these countries and the deny list is irrelevant. " +
		"Clearing the list removes the restriction rather than refusing everything.",
	denied: "Countries international calls never reach. Only consulted when there is no allow list.",
	hold:
		"The first call to a country this organization has never called before is refused and raises " +
		"a signal, rather than being placed and reviewed afterwards. The country is remembered, so " +
		"the block is once per country, not once per call.",
	offHours:
		"Refuse international calls inside a nightly window, which is when a compromised extension " +
		"is worth the most and when nobody is watching.",
	offHoursTimezone:
		"What the window is measured in. Empty uses this organization's default routing time zone. " +
		"A zone this deployment does not recognise means the lock does not apply, rather than " +
		"applying at the wrong hour.",
	autoSuspend:
		"Suspend an extension's outbound calling automatically when the detector raises a signal " +
		"against it. Off by default: an automatic suspension is a phone that stops working with " +
		"nobody in the loop, and restoring it is a manual act.",
} as const;

export function FraudControlsPanel() {
	const policy = useTollFraudPolicy();

	return (
		<div className="flex flex-col gap-6">
			{policy.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading fraud controls" />
					</CardBody>
				</Card>
			) : (
				<>
					<UsagePanel />
					<RequirePermission
						permissions={["toll-fraud.write"]}
						fallback={<ReadOnlyView policy={policy.data ?? null} />}
					>
						<PolicyForm policy={policy.data ?? null} />
					</RequirePermission>
				</>
			)}
		</div>
	);
}

function PolicyForm({ policy }: { policy: TollFraudPolicy | null }) {
	const save = useSaveTollFraudPolicy();

	const form = useForm({
		defaultValues: EMPTY_TOLL_FRAUD_POLICY_FORM,
		validators: { onSubmit: tollFraudPolicyFormSchema },
		onSubmit: async ({ value }) => {
			const next = fromPolicyFormValues(tollFraudPolicyFormSchema.parse(value));
			await save.mutateAsync(next);
			// Re-base on what was just written, so Save goes quiet until the next edit.
			form.reset(value);
		},
	});

	useEffect(() => {
		if (policy) {
			form.reset(toPolicyFormValues(policy));
		}
	}, [policy, form]);

	// A tenant with no row starts from the column defaults, which is what the first save will store.
	const loaded =
		policy === null ? fromPolicyFormValues(EMPTY_TOLL_FRAUD_POLICY_FORM) : policyToWrite(policy);

	return (
		<form
			noValidate
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			{policy === null ? (
				<NoticeBanner title="No fraud policy yet" description={COPY.unconstrained} />
			) : (
				<NoticeBanner title="Changes are live immediately" description={COPY.live} />
			)}

			<Card>
				<CardHeader>
					<CardTitle>Spend ceilings</CardTitle>
					<CardDescription>
						How much international calling this organization may do before the platform starts
						refusing. Every ceiling is optional and empty means no limit.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="enabled">
						{(field) => (
							<SwitchField
								field={field}
								label="Apply fraud controls"
								description={COPY.enabled}
								disabled={save.isPending}
							/>
						)}
					</form.Field>

					<form.Field name="maxConcurrentInternationalCalls">
						{(field) => (
							<TextField
								field={field}
								label="Concurrent international calls"
								placeholder="No limit"
								description={COPY.concurrent}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>

					<form.Field name="maxInternationalMinutesPerHour">
						{(field) => (
							<TextField
								field={field}
								label="International minutes per hour"
								placeholder="No limit"
								description={COPY.minutesHour}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>

					<form.Field name="maxInternationalMinutesPerDay">
						{(field) => (
							<TextField
								field={field}
								label="International minutes per day"
								placeholder="No limit"
								description={COPY.minutesDay}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>
				</CardBody>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Where calls may go</CardTitle>
					<CardDescription>
						An allow list, when set, wins outright — the deny list is not consulted at all. Both are
						matched against the country this platform resolves the dialled number to.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="allowedCountries">
						{(field) => (
							<CountryListField
								field={field}
								label="Allowed countries"
								description={COPY.allowed}
								emptyMeaning="No allow list — every country is reachable unless it is denied below."
								disabled={save.isPending}
							/>
						)}
					</form.Field>

					<form.Field name="deniedCountries">
						{(field) => (
							<CountryListField
								field={field}
								label="Denied countries"
								description={COPY.denied}
								emptyMeaning="No deny list."
								disabled={save.isPending}
							/>
						)}
					</form.Field>

					<form.Field name="holdFirstCallToNewCountry">
						{(field) => (
							<SwitchField
								field={field}
								label="Hold the first call to a new country"
								description={COPY.hold}
								disabled={save.isPending}
							/>
						)}
					</form.Field>
				</CardBody>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Out of hours</CardTitle>
					<CardDescription>
						A nightly window in which international calls are refused. The window may wrap past
						midnight — 20:00 to 07:00 is the default and does.
					</CardDescription>
				</CardHeader>
				<CardBody className="space-y-5">
					<form.Field name="offHoursInternationalLock">
						{(field) => (
							<SwitchField
								field={field}
								label="Lock international calling out of hours"
								description={COPY.offHours}
								disabled={save.isPending}
							/>
						)}
					</form.Field>

					{/* Plain text on a 24-hour clock rather than `<input type="time">`: the shared
					    `TextField` takes a closed set of input types, and widening it for one screen is a
					    change to every form in the app. The schema refuses anything that is not HH:MM. */}
					<div className="grid gap-4 sm:max-w-md sm:grid-cols-2">
						<form.Field name="offHoursStart">
							{(field) => (
								<TextField
									field={field}
									label="Lock from"
									placeholder="20:00"
									disabled={save.isPending}
								/>
							)}
						</form.Field>
						<form.Field name="offHoursEnd">
							{(field) => (
								<TextField
									field={field}
									label="Lock until"
									placeholder="07:00"
									disabled={save.isPending}
								/>
							)}
						</form.Field>
					</div>

					<form.Field name="offHoursTimezone">
						{(field) => (
							<TextField
								field={field}
								label="Window time zone"
								placeholder="Organization default"
								description={COPY.offHoursTimezone}
								disabled={save.isPending}
								className="max-w-md"
							/>
						)}
					</form.Field>

					<form.Field name="autoSuspendOnSignal">
						{(field) => (
							<SwitchField
								field={field}
								label="Suspend an extension automatically on a fraud signal"
								description={COPY.autoSuspend}
								disabled={save.isPending}
							/>
						)}
					</form.Field>
				</CardBody>
				<CardFooter className="justify-between gap-4">
					<form.Subscribe selector={(state) => state.values}>
						{(values) => {
							const count = changedPolicyKeys(loaded, fromPolicyFormValues(values)).length;
							return (
								<>
									<p className="text-xs text-muted-foreground">
										{count === 0
											? "No unsaved changes."
											: `${String(count)} control${count === 1 ? "" : "s"} changed — saving replaces the whole policy.`}
									</p>
									<Button
										type="submit"
										variant="primary"
										loading={save.isPending}
										disabled={count === 0}
									>
										{policy === null ? "Create policy" : "Save fraud controls"}
									</Button>
								</>
							);
						}}
					</form.Subscribe>
				</CardFooter>
			</Card>
		</form>
	);
}

/**
 * What this organization is currently metering, against what it may.
 *
 * Above the form rather than below it, because a ceiling is only meaningful beside the number it is
 * being compared to — the same argument `/org-limits` makes for keeping quota and usage on one
 * screen. The concurrency line carries its caveat in words: it is legs this deployment saw answer
 * and has not seen end, not a census of what is on the wire.
 */
function UsagePanel() {
	const usage = useTollFraudUsage();
	const display = regionDisplayNames();
	const data = usage.data;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Right now</CardTitle>
				<CardDescription>
					What this organization has spent internationally, measured by the platform's own counters.
				</CardDescription>
			</CardHeader>
			<CardBody className="space-y-3 text-sm">
				{data === undefined ? (
					<p className="text-muted-foreground">
						{usage.isPending ? "Loading…" : "Usage is unavailable right now."}
					</p>
				) : (
					<>
						<dl className="grid gap-4 sm:grid-cols-3">
							<Measure
								label="International calls up"
								value={data.concurrentInternationalCalls}
								ceiling={data.maxConcurrentInternationalCalls}
							/>
							<Measure
								label="Minutes, last hour"
								value={data.internationalMinutesLastHour}
								ceiling={data.maxInternationalMinutesPerHour}
							/>
							<Measure
								label="Minutes, last day"
								value={data.internationalMinutesLastDay}
								ceiling={data.maxInternationalMinutesPerDay}
							/>
						</dl>
						<p className="text-xs text-muted-foreground">
							The concurrency figure counts international legs this platform saw answer and has not
							yet seen end. It is authoritative for calls placed through this deployment and knows
							nothing about anything else.
						</p>
						<CountriesSeen countries={data.countriesSeen} display={display} usage={data} />
					</>
				)}
			</CardBody>
		</Card>
	);
}

function Measure({
	label,
	value,
	ceiling,
}: {
	label: string;
	value: number;
	ceiling: number | null;
}) {
	return (
		<div>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-lg font-medium text-foreground">
				{value.toLocaleString("en-US")}
				<span className="text-sm font-normal text-muted-foreground">
					{ceiling === null ? " of no limit" : ` of ${ceiling.toLocaleString("en-US")}`}
				</span>
			</dd>
		</div>
	);
}

/** The set "hold the first call to a new country" compares a destination against. */
function CountriesSeen({
	countries,
	display,
	usage,
}: {
	countries: readonly string[];
	display: Intl.DisplayNames | null;
	usage: TollFraudUsage;
}) {
	return (
		<div className="border-t border-border pt-3">
			<p className="text-xs text-muted-foreground">
				Countries this organization has called before, as of {new Date(usage.at).toLocaleString()}.
				A country not on this list is the one the hold setting refuses.
			</p>
			{countries.length === 0 ? (
				<p className="mt-1 text-sm text-muted-foreground">None recorded yet.</p>
			) : (
				<p className="mt-1 text-sm text-foreground">
					{countries.map((code) => countryLabel(code, display)).join(", ")}
				</p>
			)}
		</div>
	);
}

/**
 * What a role with `toll-fraud.read` and no `toll-fraud.write` sees.
 *
 * The facts rather than a disabled form, on the routing screen's terms: a greyed-out control
 * invites somebody to try to change it and says nothing about what the value means. The manager
 * fielding "why can this phone not call Germany?" is exactly who holds this grant and no other, so
 * the two lists that answer that question come first.
 */
function ReadOnlyView({ policy }: { policy: TollFraudPolicy | null }) {
	const display = regionDisplayNames();
	const list = (codes: readonly string[] | null, none: string) =>
		codes === null || codes.length === 0
			? none
			: codes.map((code) => countryLabel(code, display)).join(", ");

	return (
		<Card>
			<CardHeader>
				<CardTitle>Fraud controls</CardTitle>
				<CardDescription>Your role can view these controls but not change them.</CardDescription>
			</CardHeader>
			<CardBody className="space-y-2 text-sm text-foreground">
				{policy === null ? (
					<p>{COPY.unconstrained}</p>
				) : (
					<>
						<p>Fraud controls are {policy.enabled ? "applied" : "switched off"}.</p>
						<p className="text-muted-foreground">
							Allowed countries: {list(policy.allowedCountries, "no allow list")}
						</p>
						<p className="text-muted-foreground">
							Denied countries: {list(policy.deniedCountries, "no deny list")}
						</p>
						<p className="text-muted-foreground">
							Ceilings: {ceilingText(policy.maxConcurrentInternationalCalls, "concurrent calls")},{" "}
							{ceilingText(policy.maxInternationalMinutesPerHour, "minutes an hour")},{" "}
							{ceilingText(policy.maxInternationalMinutesPerDay, "minutes a day")}
						</p>
						<p className="text-muted-foreground">
							Out-of-hours lock: {policy.offHoursInternationalLock ? "on" : "off"}. First call to a
							new country: {policy.holdFirstCallToNewCountry ? "held" : "allowed"}.
						</p>
					</>
				)}
			</CardBody>
		</Card>
	);
}

function ceilingText(value: number | null, unit: string): string {
	return value === null ? `no limit on ${unit}` : `${value.toLocaleString("en-US")} ${unit}`;
}
