"use client";

import { EmptyState } from "~/components/ui/empty-state";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { destinationTypeLabel, formatDuration } from "~/lib/cdr/format";
import { answerRatePct, busiestBucket, destinationTotals, volumeTotals } from "~/lib/cdr/reporting";
import type { CallVolumeResult } from "../../_hooks/use-cdr-queries";
import type { CallVolumeRow } from "~/lib/cdr/contracts";

/**
 * Call volume over time.
 *
 * ## The bars are CSS, not a charting library
 *
 * What this draws is one value per bucket against the busiest bucket in the same series. That is a
 * `width` percentage, and reaching for a chart library to compute it would put a hundred kilobytes
 * of canvas into a page that renders a bar chart a screen reader can also read — the table IS the
 * chart here, and the bar is a background on the cell. When this needs axes, tooltips and a second
 * series overlaid, that is the moment to add the dependency, not before.
 *
 * ## An idle bucket is not a failing one
 *
 * `answerRatePct` returns `null` for a bucket with no calls and this renders that as an em dash
 * rather than `0%`, for the reason the wallboard renders "No traffic": a quiet Sunday and an hour
 * where nobody picked up are different facts and must not share a colour or a number.
 */
export function CallVolumePanel({ volume }: { readonly volume: CallVolumeResult }) {
	if (volume.query.isPending) {
		return <LoadingPanel label="Loading call volume" />;
	}

	const envelope = volume.envelope;
	const rows = envelope?.data ?? [];

	if (rows.length === 0) {
		return (
			<EmptyState
				title="No calls in this window"
				description="Nothing reached this organization between the two instants above. Widen the window to see further back."
			/>
		);
	}

	const totals = volumeTotals(rows);
	// The scale is the busiest bucket, so the tallest bar is always full width: a chart scaled to a
	// round number instead would render a whole quiet week as a row of invisible slivers.
	const peak = busiestBucket(rows)?.total ?? 0;
	const destinations = destinationTotals(envelope?.destinations ?? []);

	return (
		<div className="flex flex-col gap-4">
			{envelope?.truncated ? (
				<p className="text-xs text-warning">
					This series stops at the server&apos;s bucket ceiling and is incomplete. Narrow the window
					or switch to daily buckets.
				</p>
			) : null}

			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
				<Figure label="Calls" value={String(totals.total)} />
				<Figure label="Inbound" value={String(totals.inbound)} />
				<Figure label="Outbound" value={String(totals.outbound)} />
				<Figure label="Internal" value={String(totals.internal)} />
				<Figure
					label="Answered"
					value={totals.answerRatePct === null ? "—" : `${totals.answerRatePct.toFixed(1)}%`}
				/>
				<Figure label="Average call" value={formatDuration(totals.averageBillsecMs)} />
			</dl>

			<TableContainer>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{envelope?.bucket === "day" ? "Day" : "Hour"}</TableHead>
							<TableHead className="text-right">Calls</TableHead>
							<TableHead className="text-right">In</TableHead>
							<TableHead className="text-right">Out</TableHead>
							<TableHead className="text-right">Internal</TableHead>
							<TableHead className="text-right">Answered</TableHead>
							<TableHead className="text-right">Average call</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<VolumeRow
								key={row.bucket}
								row={row}
								peak={peak}
								daily={envelope?.bucket === "day"}
							/>
						))}
					</TableBody>
				</Table>
			</TableContainer>

			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-foreground">Where the calls went</h3>
				<p className="max-w-prose text-xs text-muted-foreground">
					Across the whole window. A destination nobody routed to is absent rather than zero — the
					list is what the ledger recorded, not the routing table.
				</p>
				<div className="flex flex-wrap gap-2">
					{destinations.map((entry) => (
						<div
							key={entry.destinationType}
							className="rounded-md border border-border px-3 py-2 text-xs"
						>
							<div className="font-medium text-foreground">
								{destinationTypeLabel(entry.destinationType)}
							</div>
							<div className="tabular-nums text-muted-foreground">
								{entry.total} calls · {entry.answered} answered
							</div>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}

function VolumeRow({
	row,
	peak,
	daily,
}: {
	readonly row: CallVolumeRow;
	readonly peak: number;
	readonly daily: boolean;
}) {
	const rate = answerRatePct(row);
	const width = peak === 0 ? 0 : Math.round((row.total / peak) * 100);
	const at = new Date(row.bucket);

	return (
		<TableRow>
			<TableCell className="relative whitespace-nowrap tabular-nums">
				{/*
				 * The bar is a background behind the label rather than its own column: a separate chart
				 * column would need its own header and would be the one thing a narrow screen dropped.
				 */}
				<span
					aria-hidden
					className="absolute inset-y-1 left-0 rounded-sm bg-accent/25"
					style={{ width: `${String(width)}%` }}
				/>
				<span className="relative">{daily ? at.toLocaleDateString() : at.toLocaleString()}</span>
			</TableCell>
			<TableCell className="text-right tabular-nums">{row.total}</TableCell>
			<TableCell className="text-right tabular-nums">{row.inbound}</TableCell>
			<TableCell className="text-right tabular-nums">{row.outbound}</TableCell>
			<TableCell className="text-right tabular-nums">{row.internal}</TableCell>
			<TableCell className="text-right tabular-nums">
				{rate === null ? "—" : `${rate.toFixed(1)}%`}
			</TableCell>
			<TableCell className="text-right tabular-nums">
				{formatDuration(row.averageBillsecMs)}
			</TableCell>
		</TableRow>
	);
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
	return (
		<div className="rounded-md border border-border px-3 py-2">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
		</div>
	);
}
