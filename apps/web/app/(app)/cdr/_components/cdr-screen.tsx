"use client";

import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { Fragment, useId, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { HistoryIcon } from "~/components/ui/icons";
import { PageHeader } from "~/components/ui/page-header";
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
import { DEFAULT_CDR_LIMIT } from "~/lib/cdr/client";
import {
	destinationTypeLabel,
	directionLabel,
	directionTone,
	dispositionLabel,
	dispositionTone,
	formatBillsec,
	formatDuration,
	hangupCauseLabel,
	hangupCauseTone,
} from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { useCdrList } from "../../_hooks/use-cdr-queries";
import { CallDetail } from "./call-detail";
import { RANGE_PRESET_LABELS, RANGE_PRESETS, useTimeRangeState } from "./time-range";
import type { CallLegRow } from "~/lib/cdr/contracts";

const DIRECTIONS = ["", "inbound", "outbound", "internal"] as const;
const DISPOSITIONS = ["", "answered", "no-answer", "busy", "failed", "voicemail"] as const;

/**
 * Call history.
 *
 * ## Rows are LEGS; the expansion is the CALL
 *
 * `call_legs` has one row per channel leg, and a call is the set of rows sharing `call_id`. The
 * table lists legs because that is what a time-ordered history is, and expanding a row loads the
 * whole call — every B-leg the engine originated, indented by which leg dialled it. Listing calls
 * instead would need a server-side aggregate over a partitioned ledger on every page; listing legs
 * and expanding on demand costs one extra request only for the rows someone actually opens.
 *
 * ## Paging is a cursor, so there is no page number and no total
 *
 * The API returns `nextCursor` and no `total`, deliberately — a `count(*)` over the partitions a
 * range touches is the exact cost keyset pagination exists to avoid. The control is therefore
 * "Newer / Older" over a cursor stack rather than "Page 3 of 47", and the stack is what makes
 * "Newer" work at all: a keyset cursor points forward, so going back means remembering where you
 * were rather than computing it.
 *
 * ## Everything is in the URL
 *
 * A support conversation about a phone system is "look at this call", which has to be a link. Range,
 * filters and search are `nuqs` query state for the same reason the PBX lists are.
 */
export function CdrScreen() {
	const range = useTimeRangeState();
	const searchId = useId();
	const directionId = useId();
	const dispositionId = useId();
	const extensionId = useId();

	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [direction, setDirection] = useQueryState(
		"direction",
		parseAsStringLiteral(DIRECTIONS).withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [disposition, setDisposition] = useQueryState(
		"disposition",
		parseAsStringLiteral(DISPOSITIONS).withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [extension, setExtension] = useQueryState(
		"extension",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);

	/**
	 * The cursor stack.
	 *
	 * Component state rather than URL state, and that is the one deliberate exception to "everything
	 * is in the URL": a cursor is a position inside a result set, so a shared link carrying page
	 * four's cursor would open on rows the recipient has no context for. Sharing a FILTER is useful;
	 * sharing a scroll position is not.
	 */
	const [cursors, setCursors] = useState<readonly string[]>([]);
	const cursor = cursors[cursors.length - 1];

	const query = useMemo(
		() => ({
			from: range.from,
			to: range.to,
			search: search.length > 0 ? search : undefined,
			direction: direction.length > 0 ? direction : undefined,
			disposition: disposition.length > 0 ? disposition : undefined,
			extension: extension.length > 0 ? extension : undefined,
			limit: DEFAULT_CDR_LIMIT,
			cursor,
		}),
		[range.from, range.to, search, direction, disposition, extension, cursor],
	);

	const list = useCdrList(query);
	const [expanded, setExpanded] = useState<string | null>(null);

	/** Any filter change resets paging: a cursor into the previous result set means nothing here. */
	const resetPaging = (): void => {
		setCursors([]);
		setExpanded(null);
	};

	const filtered =
		search.length > 0 ||
		direction.length > 0 ||
		disposition.length > 0 ||
		extension.length > 0;

	return (
		<>
			<PageHeader
				title="Call history"
				description="One row per call leg, newest first. Expand a row to see every leg of that call — who dialled whom, which one answered, and how each ended."
			/>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<label htmlFor="cdr-range" className="text-xs font-medium text-muted-foreground">
						Time range
					</label>
					<select
						id="cdr-range"
						value={range.preset}
						onChange={(event) => {
							range.setPreset(event.target.value as (typeof RANGE_PRESETS)[number]);
							resetPaging();
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
							<label htmlFor="cdr-from" className="text-xs font-medium text-muted-foreground">
								From
							</label>
							<input
								id="cdr-from"
								type="datetime-local"
								value={range.customFrom}
								onChange={(event) => {
									range.setCustomFrom(event.target.value);
									resetPaging();
								}}
								className={inputClassName}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="cdr-to" className="text-xs font-medium text-muted-foreground">
								To
							</label>
							<input
								id="cdr-to"
								type="datetime-local"
								value={range.customTo}
								onChange={(event) => {
									range.setCustomTo(event.target.value);
									resetPaging();
								}}
								className={inputClassName}
							/>
						</div>
					</>
				) : null}

				<div className="flex min-w-52 flex-1 flex-col gap-1.5">
					<label htmlFor={searchId} className="text-xs font-medium text-muted-foreground">
						Search
					</label>
					<input
						id={searchId}
						type="search"
						value={search}
						onChange={(event) => {
							void setSearch(event.target.value);
							resetPaging();
						}}
						placeholder="Caller, callee or caller name"
						className={inputClassName}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label htmlFor={extensionId} className="text-xs font-medium text-muted-foreground">
						Number
					</label>
					<input
						id={extensionId}
						type="text"
						value={extension}
						onChange={(event) => {
							void setExtension(event.target.value);
							resetPaging();
						}}
						placeholder="Exactly 1001"
						className={cn(inputClassName, "w-36")}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label htmlFor={directionId} className="text-xs font-medium text-muted-foreground">
						Direction
					</label>
					<select
						id={directionId}
						value={direction}
						onChange={(event) => {
							void setDirection(event.target.value as (typeof DIRECTIONS)[number]);
							resetPaging();
						}}
						className={cn(inputClassName, "w-36 pr-8")}
					>
						<option value="">All</option>
						<option value="inbound">Inbound</option>
						<option value="outbound">Outbound</option>
						<option value="internal">Internal</option>
					</select>
				</div>

				<div className="flex flex-col gap-1.5">
					<label htmlFor={dispositionId} className="text-xs font-medium text-muted-foreground">
						Outcome
					</label>
					<select
						id={dispositionId}
						value={disposition}
						onChange={(event) => {
							void setDisposition(event.target.value as (typeof DISPOSITIONS)[number]);
							resetPaging();
						}}
						className={cn(inputClassName, "w-36 pr-8")}
					>
						<option value="">All</option>
						<option value="answered">Answered</option>
						<option value="no-answer">No answer</option>
						<option value="busy">Busy</option>
						<option value="voicemail">Voicemail</option>
						<option value="failed">Failed</option>
					</select>
				</div>
			</div>

			<CdrTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={filtered}
				expanded={expanded}
				onToggle={(callId) => setExpanded((current) => (current === callId ? null : callId))}
				range={{ from: range.from, to: range.to }}
			/>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-xs text-muted-foreground">
					{list.range
						? `Showing calls from ${new Date(list.range.from).toLocaleString()} to ${new Date(list.range.to).toLocaleString()}.`
						: null}
				</p>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="secondary"
						disabled={cursors.length === 0}
						onClick={() => {
							setCursors((current) => current.slice(0, -1));
							setExpanded(null);
						}}
					>
						Newer
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={list.nextCursor === null}
						onClick={() => {
							const next = list.nextCursor;
							if (next !== null) {
								setCursors((current) => [...current, next]);
								setExpanded(null);
							}
						}}
					>
						Older
					</Button>
				</div>
			</div>

			<p className="max-w-prose text-xs text-muted-foreground">
				Call history is an append-only record: it can be read and exported, never edited. Rows
				are retired as whole months by the retention policy.
			</p>
		</>
	);
}

function CdrTable({
	rows,
	isPending,
	filtered,
	expanded,
	onToggle,
	range,
}: {
	rows: readonly CallLegRow[];
	isPending: boolean;
	filtered: boolean;
	expanded: string | null;
	onToggle: (callId: string) => void;
	range: { readonly from?: string | undefined; readonly to?: string | undefined };
}) {
	if (isPending) {
		return <LoadingPanel label="Loading call history" />;
	}
	if (rows.length === 0) {
		return filtered ? (
			<EmptyState
				title="Nothing matched"
				description="No calls match the current filters in this time range. Widen the range or clear a filter."
			/>
		) : (
			<EmptyState
				icon={<HistoryIcon className="size-5" />}
				title="No calls in this time range"
				description="Call records appear here as soon as calls complete. Try a wider time range if you expected to see history."
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Call detail records, newest first</caption>
				<TableHeader>
					<TableRow>
						<TableHead>Started</TableHead>
						<TableHead>Direction</TableHead>
						<TableHead>From</TableHead>
						<TableHead>To</TableHead>
						<TableHead>Went to</TableHead>
						<TableHead>Outcome</TableHead>
						<TableHead>Cause</TableHead>
						<TableHead className="text-right">Duration</TableHead>
						<TableHead className="text-right">Billed</TableHead>
						<TableHead className="w-0">
							<span className="sr-only">Legs</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<Fragment key={row.id}>
							<TableRow>
								<TableCell className="whitespace-nowrap" data-tabular>
									{new Date(row.startedAt).toLocaleString()}
								</TableCell>
								<TableCell>
									<Badge tone={directionTone(row.direction)}>{directionLabel(row.direction)}</Badge>
								</TableCell>
								<TableCell className="font-mono whitespace-nowrap">
									{row.fromNumber}
									{row.fromName ? (
										<span className="block font-sans text-xs text-muted-foreground">
											{row.fromName}
										</span>
									) : null}
								</TableCell>
								<TableCell className="font-mono whitespace-nowrap">{row.toNumber}</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{destinationTypeLabel(row.destinationType)}
								</TableCell>
								<TableCell>
									<Badge tone={dispositionTone(row.disposition)}>
										{dispositionLabel(row.disposition)}
									</Badge>
								</TableCell>
								<TableCell>
									<Badge tone={hangupCauseTone(row.hangupCause)}>
										{hangupCauseLabel(row.hangupCause)}
									</Badge>
								</TableCell>
								<TableCell className="text-right whitespace-nowrap" data-tabular>
									{formatDuration(row.durationMs)}
								</TableCell>
								<TableCell className="text-right whitespace-nowrap" data-tabular>
									{formatBillsec(row.billsecMs)}
								</TableCell>
								<TableCell className="text-right whitespace-nowrap">
									<Button
										size="sm"
										variant="ghost"
										aria-expanded={expanded === row.callId}
										onClick={() => onToggle(row.callId)}
									>
										{expanded === row.callId ? "Hide legs" : "All legs"}
									</Button>
								</TableCell>
							</TableRow>
							{expanded === row.callId ? (
								<TableRow>
									<TableCell colSpan={10} className="bg-muted/30 p-0">
										<CallDetail callId={row.callId} range={range} />
									</TableCell>
								</TableRow>
							) : null}
						</Fragment>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	);
}
