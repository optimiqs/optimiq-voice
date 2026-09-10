"use client";

import { parseAsInteger, parseAsStringLiteral, useQueryState } from "nuqs";
import { useId } from "react";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import {
	DEFAULT_VOLUME_BUCKET,
	DEFAULT_WRAP_UP_SECONDS,
	MAX_WRAP_UP_SECONDS,
	VOLUME_BUCKET_LABELS,
	VOLUME_BUCKETS,
} from "~/lib/cdr/client";
import { cn } from "~/lib/cn";
import { usePermission } from "../../_context/session-context";
import { useAgentStats, useCallVolume } from "../../_hooks/use-cdr-queries";
import {
	RANGE_PRESET_LABELS,
	RANGE_PRESETS,
	useTimeRangeState,
	type RangePreset,
} from "../../cdr/_components/time-range";
import { AgentStatsTable } from "./agent-stats-table";
import { CallVolumePanel } from "./call-volume-panel";

/**
 * Reports — the historical half of the reporting area, over one window.
 *
 * ## Two sections on two DIFFERENT grants, and the page has to survive holding only one
 *
 * Agent statistics ride `queues.monitor` — the aggregate grant the wallboard already uses, because
 * what comes back names no call — and call volume rides `cdr.read`, the unscoped call-history
 * grant, because there is no honest per-person version of "we took 400 calls this week". A
 * supervisor typically holds both, an agent holds only the first, and a finance role might hold only
 * the second. So each section is rendered or replaced independently rather than the page being
 * gated as a whole: a screen that 403s entirely because one of its two halves is not permitted is a
 * screen somebody files a bug about.
 *
 * ## One window, two questions, and the window is in the URL
 *
 * Both sections read the same `from`/`to`, held in the URL by `useTimeRangeState` for the reason
 * that hook argues: a link that says "the last day" keeps meaning the last day. The two controls
 * that are not the window — the wrap-up cap and the bucket grain — are in the URL beside it, for
 * the same reason the wallboard's SLA target is: they are QUESTIONS a reader compares answers to,
 * and a comparison you cannot paste into a conversation is a comparison nobody shares.
 *
 * ## Nothing here polls
 *
 * Deliberately, and it is the one difference from the wallboard. A wallboard is watched; a report is
 * read, sorted and acted on, and rows re-ordering under somebody's cursor every thirty seconds is
 * how a report stops being trusted. It refetches when the window changes, which is when the answer
 * actually changed.
 */
export function ReportsScreen() {
	const range = useTimeRangeState();
	const canSeeAgents = usePermission("queues.monitor");
	const canSeeVolume = usePermission("cdr.read");

	const [wrapUpSeconds, setWrapUpSeconds] = useQueryState(
		"wrapup",
		parseAsInteger.withDefault(DEFAULT_WRAP_UP_SECONDS).withOptions({ clearOnDefault: true }),
	);
	const [bucket, setBucket] = useQueryState(
		"bucket",
		parseAsStringLiteral(VOLUME_BUCKETS)
			.withDefault(DEFAULT_VOLUME_BUCKET)
			.withOptions({ clearOnDefault: true }),
	);

	const stats = useAgentStats({ from: range.from, to: range.to, wrapUpSeconds });
	const volume = useCallVolume({ from: range.from, to: range.to, bucket });

	const presetId = useId();
	const wrapUpId = useId();
	const bucketId = useId();

	return (
		<>
			<PageHeader
				title="Reports"
				description="What the call ledger recorded over the window below — who handled the queue calls, and how the traffic moved. Historical, and nothing here can be edited."
			/>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={presetId} className="text-xs font-medium text-muted-foreground">
						Window
					</label>
					<select
						id={presetId}
						value={range.preset}
						onChange={(event) => {
							range.setPreset(event.target.value as RangePreset);
						}}
						className={cn(inputClassName, "w-44 pr-8")}
					>
						{RANGE_PRESETS.map((preset) => (
							<option key={preset} value={preset}>
								{RANGE_PRESET_LABELS[preset]}
							</option>
						))}
					</select>
				</div>

				{range.preset === "custom" ? (
					<>
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor={`${presetId}-from`}
								className="text-xs font-medium text-muted-foreground"
							>
								From
							</label>
							<input
								id={`${presetId}-from`}
								type="datetime-local"
								value={range.customFrom}
								onChange={(event) => {
									range.setCustomFrom(event.target.value);
								}}
								className={inputClassName}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor={`${presetId}-to`}
								className="text-xs font-medium text-muted-foreground"
							>
								To
							</label>
							<input
								id={`${presetId}-to`}
								type="datetime-local"
								value={range.customTo}
								onChange={(event) => {
									range.setCustomTo(event.target.value);
								}}
								className={inputClassName}
							/>
						</div>
					</>
				) : null}

				<div className="flex flex-col gap-1.5">
					<label htmlFor={bucketId} className="text-xs font-medium text-muted-foreground">
						Grain
					</label>
					<select
						id={bucketId}
						value={bucket}
						onChange={(event) => {
							void setBucket(event.target.value as (typeof VOLUME_BUCKETS)[number]);
						}}
						className={cn(inputClassName, "w-32 pr-8")}
					>
						{VOLUME_BUCKETS.map((value) => (
							<option key={value} value={value}>
								{VOLUME_BUCKET_LABELS[value]}
							</option>
						))}
					</select>
				</div>

				<div className="flex flex-col gap-1.5">
					<label htmlFor={wrapUpId} className="text-xs font-medium text-muted-foreground">
						Wrap-up cap (seconds)
					</label>
					<input
						id={wrapUpId}
						type="number"
						min={1}
						max={MAX_WRAP_UP_SECONDS}
						value={wrapUpSeconds}
						onChange={(event) => {
							const next = Number(event.target.value);
							// Anything unparseable falls back to the server's own default rather than being
							// sent: a half-typed number is a keystroke, not a question.
							void setWrapUpSeconds(Number.isFinite(next) && next > 0 ? next : null);
						}}
						className={cn(inputClassName, "w-32")}
					/>
				</div>
			</div>

			<section className="flex flex-col gap-3">
				<header>
					<h2 className="text-sm font-semibold text-foreground">Agents</h2>
					<p className="max-w-prose text-xs text-muted-foreground">
						Calls each agent answered from a queue, and how long they spent on them.
						&ldquo;Wrap-up&rdquo; is the gap before their next call, capped at{" "}
						{String(stats.wrapUpSeconds ?? wrapUpSeconds)} seconds — nothing here records an
						after-call-work state, so it is a measurement of recovery time and not of typing.
					</p>
				</header>
				{canSeeAgents ? (
					<AgentStatsTable stats={stats} />
				) : (
					<EmptyState
						title="You cannot see agent statistics"
						description="This table needs the permission that also opens the wallboard. Ask an administrator for queue monitoring."
					/>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<header>
					<h2 className="text-sm font-semibold text-foreground">Call volume</h2>
					<p className="max-w-prose text-xs text-muted-foreground">
						Every leg the ledger recorded in the window, bucketed. &ldquo;Answered&rdquo; means a
						media path was established — not that a caller reached a mailbox.
					</p>
				</header>
				{canSeeVolume ? (
					<CallVolumePanel volume={volume} />
				) : (
					<EmptyState
						title="You cannot see call volume"
						description="An organization-wide call count needs the unscoped call-history permission. There is no version of this number narrowed to your own calls."
					/>
				)}
			</section>
		</>
	);
}
