"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
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
import { TextField } from "~/components/ui/form-fields";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ORG_LIMIT_NAMES } from "~/lib/pbx/contracts";
import { orgLimitsFormSchema, type OrgLimitsFormValues } from "~/lib/pbx/schemas";
import { routes } from "~/lib/routes";
import { RequirePermission } from "../../_components/require-permission";
import { useOrgLimits, useOrgLimitsSave, useOrgUsage } from "../../_hooks/use-pbx-queries";
import { SettingsNav } from "../_components/settings-nav";
import type { OrgLimitName, OrgUsageEntry } from "~/lib/pbx/contracts";

/**
 * The organization's four quotas, and what it is using against them.
 *
 * ## Two of the four numbers are incomplete, and the page says which
 *
 * A usage screen that quietly rounded off what it cannot measure would be worse than no screen: an
 * administrator reads "12 of 50 MB" and concludes they have room, when the largest category is not
 * in the total at all. So both gaps are stated beside the bar they affect rather than in a footnote:
 *
 * - **Simultaneous calls** always report zero used. They are live state the engine holds; the
 *   control plane cannot see them, and a number this page invented would be wrong the moment it was
 *   read. The CEILING is real and is enforced by the engine at admission, which is the fact somebody
 *   came here for.
 * - **Storage** counts prompts and voicemail only. Recordings live in the call-detail database — a
 *   different connection and a different bounded context — so reaching across for a number would make
 *   this page fail whenever that database is slow.
 *
 * ## Why the write is `owner`-only, and why the page says so
 *
 * A limit an administrator can raise is not a limit. The correct owner is a platform operator — the
 * reseller hierarchy this plan calls W14 — and that surface does not exist yet, so the interim is
 * stated rather than smuggled: `org-limits.write` is held by `owner` alone and is excluded from the
 * administrator template. It is not a real control-plane boundary and this page does not pretend it
 * is one; an owner can raise their own cap. What it buys is that the columns, the enforcement and the
 * accounting exist and are tested, so the reseller wave moves a permission rather than building a
 * feature.
 *
 * `org-limits.read` is much wider on purpose, because this is a SUPPORT screen: "you are at 48 of 50
 * extensions" is the answer to a ticket, and hiding it from the people who field those tickets would
 * make the limit surface as a create button that fails.
 */

const LIMIT_LABELS: Readonly<Record<OrgLimitName, string>> = {
	maxExtensions: "Extensions",
	maxTrunks: "Trunks",
	maxConcurrentCalls: "Simultaneous calls",
	maxStorageMb: "Stored audio (MB)",
};

const LIMIT_DESCRIPTIONS: Readonly<Record<OrgLimitName, string>> = {
	maxExtensions:
		"Refused when the next extension would exceed it, with a message naming the ceiling and the current count.",
	maxTrunks: "Refused at create, exactly as extensions are.",
	maxConcurrentCalls:
		"Enforced by the engine when a call is admitted, not by a form — there is no row to refuse, only a caller. Usage cannot be reported from here.",
	maxStorageMb:
		"Refused at upload. Counts prompts and voicemail messages; recorded calls are stored elsewhere and are not included.",
};

const EMPTY_FORM: OrgLimitsFormValues = {
	maxExtensions: "",
	maxTrunks: "",
	maxConcurrentCalls: "",
	maxStorageMb: "",
};

export default function OrgLimitsPage() {
	const limits = useOrgLimits();
	const usage = useOrgUsage();
	const save = useOrgLimitsSave();

	const form = useForm({
		defaultValues: EMPTY_FORM,
		validators: { onSubmit: orgLimitsFormSchema },
		onSubmit: async ({ value }) => {
			// Every field is sent, including the blank ones. `PUT` takes the COMPLETE set of ceilings —
			// a partial body would make "remove this limit" and "leave this limit alone" the same
			// request — and a blank box here means no ceiling rather than "use the default", because
			// unlimited IS the default.
			await save.mutateAsync(orgLimitsFormSchema.parse(value));
		},
	});

	const loaded = limits.data;
	useEffect(() => {
		if (loaded) {
			form.reset({
				maxExtensions: loaded.maxExtensions == null ? "" : String(loaded.maxExtensions),
				maxTrunks: loaded.maxTrunks == null ? "" : String(loaded.maxTrunks),
				maxConcurrentCalls:
					loaded.maxConcurrentCalls == null ? "" : String(loaded.maxConcurrentCalls),
				maxStorageMb: loaded.maxStorageMb == null ? "" : String(loaded.maxStorageMb),
			});
		}
	}, [loaded, form]);

	const entries = usage.data?.entries ?? [];
	const byLimit = new Map(entries.map((entry) => [entry.limit, entry]));

	return (
		<>
			<PageHeader
				title="Limits"
				description="Ceilings on what this organization may hold, and what it is using against them. Every limit is optional — an empty box is no limit at all, which is where every organization starts."
			/>
			<SettingsNav />

			<Card>
				<CardHeader>
					<CardTitle>Usage</CardTitle>
					<CardDescription>
						Counted now, not cached. These move whenever anybody creates an extension or leaves a
						voicemail, so this panel is re-read every time the page is opened.
					</CardDescription>
				</CardHeader>
				<CardBody className="flex flex-col gap-5">
					{usage.isPending ? (
						<LoadingPanel label="Counting" />
					) : (
						ORG_LIMIT_NAMES.map((limit) => (
							<UsageBar key={limit} limit={limit} entry={byLimit.get(limit)} />
						))
					)}
					{usage.data ? (
						<p className="text-xs text-muted-foreground">
							Stored audio is {usage.data.storageBytes.toLocaleString()} bytes exactly, before the
							megabyte rounding the ceiling is compared against — the comparison divides rather than
							multiplying, so nobody is refused for a fraction of a megabyte. Recorded calls are not
							counted here: they live in the call-history database, and are governed by the{" "}
							<Link
								href={routes.recordingSettings}
								className="text-primary underline-offset-4 hover:underline"
							>
								recording retention
							</Link>{" "}
							policy instead.
						</p>
					) : null}
				</CardBody>
			</Card>

			{limits.isPending ? (
				<Card>
					<CardBody className="p-0">
						<LoadingPanel label="Loading the limits" />
					</CardBody>
				</Card>
			) : (
				<RequirePermission
					permissions={["org-limits.write"]}
					fallback={
						<Card>
							<CardHeader>
								<CardTitle>Ceilings</CardTitle>
								<CardDescription>
									Your role can see these limits but not change them. Raising a quota is held by the
									organization owner alone — a limit an administrator can raise is not a limit.
								</CardDescription>
							</CardHeader>
							<CardBody className="flex flex-col gap-3">
								{ORG_LIMIT_NAMES.map((limit) => (
									<div key={limit} className="flex items-baseline justify-between gap-4">
										<span className="text-sm text-foreground">{LIMIT_LABELS[limit]}</span>
										<span className="text-sm text-muted-foreground" data-tabular>
											{loaded?.[limit] == null ? "No limit" : loaded[limit]?.toLocaleString()}
										</span>
									</div>
								))}
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
								<CardTitle>Ceilings</CardTitle>
								<CardDescription>
									Leave a box empty for no limit. Clearing a box REMOVES the ceiling rather than
									restoring a default — there is no default to restore, because unlimited is where
									every organization begins.
								</CardDescription>
							</CardHeader>
							<CardBody className="grid gap-5 sm:grid-cols-2">
								{ORG_LIMIT_NAMES.map((limit) => (
									<form.Field key={limit} name={limit}>
										{(field) => (
											<TextField
												field={field}
												label={LIMIT_LABELS[limit]}
												placeholder="No limit"
												description={LIMIT_DESCRIPTIONS[limit]}
												disabled={save.isPending}
											/>
										)}
									</form.Field>
								))}
							</CardBody>
							<CardFooter className="flex-col items-start gap-3">
								<Button type="submit" variant="primary" loading={save.isPending}>
									Save limits
								</Button>
								<p className="max-w-prose text-xs text-muted-foreground">
									These limits belong to the organization and are raised by its owner, which is not
									a real boundary — an owner can raise their own cap. They move to the reseller
									hierarchy when that surface exists, at which point this page becomes read-only for
									everyone inside the organization and the ceilings are set by whoever sells them.
								</p>
							</CardFooter>
						</form>
					</Card>
				</RequirePermission>
			)}
		</>
	);
}

/**
 * One usage line.
 *
 * Three states, and each is a different sentence rather than a different number: no ceiling (a bar
 * would imply a boundary that does not exist), a ceiling that cannot be measured against
 * (`maxConcurrentCalls`, whose `used` is always zero and would draw an empty bar that reads as "no
 * calls"), and a real ratio.
 */
function UsageBar({ limit, entry }: { limit: OrgLimitName; entry: OrgUsageEntry | undefined }) {
	const unmeasurable = limit === "maxConcurrentCalls";
	const ceiling = entry?.ceiling ?? null;
	const used = entry?.used ?? 0;
	const ratio = entry?.ratio;
	const percent = ratio === null || ratio === undefined ? null : Math.min(100, ratio * 100);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<span className="text-sm font-medium text-foreground">{LIMIT_LABELS[limit]}</span>
				<span className="text-sm text-muted-foreground" data-tabular>
					{ceiling === null ? (
						"No limit"
					) : unmeasurable ? (
						<>Ceiling {ceiling.toLocaleString()}</>
					) : (
						<>
							{used.toLocaleString()} of {ceiling.toLocaleString()}
						</>
					)}
				</span>
			</div>

			{/*
			 * The bar is DECORATIVE, and `aria-hidden` rather than a `progressbar` role is the reason
			 * it is not a `<progress>` element either.
			 *
			 * The value is already announced, exactly and in the units an administrator acts on, by the
			 * "48 of 50" beside the label above. A progress bar carrying the same number would announce
			 * it twice — once as a figure and once as a percentage nobody asked for — which is noise on
			 * a screen whose whole job is a small number of precise counts. The bar exists to make "is
			 * this close?" answerable at a glance, which is a visual question.
			 */}
			{ceiling !== null && !unmeasurable && percent !== null ? (
				<div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<div
						className={
							percent >= 90
								? "h-full bg-danger"
								: percent >= 75
									? "h-full bg-warning"
									: "h-full bg-primary"
						}
						style={{ width: `${String(percent)}%` }}
					/>
				</div>
			) : null}

			<p className="text-xs text-muted-foreground">
				{ceiling === null ? (
					`No ceiling is set. ${LIMIT_DESCRIPTIONS[limit]}`
				) : unmeasurable ? (
					<>
						<Badge tone="neutral">Not measurable here</Badge> Simultaneous calls are live state the
						engine holds — the control plane cannot count them, so this reports the ceiling and not
						the usage. The ceiling itself is real and refuses the call at admission.
					</>
				) : (
					LIMIT_DESCRIPTIONS[limit]
				)}
			</p>
		</div>
	);
}
