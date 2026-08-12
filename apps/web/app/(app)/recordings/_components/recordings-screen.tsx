"use client";

import Link from "next/link";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useId, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { RecordIcon } from "~/components/ui/icons";
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
import { formatBytes, formatDuration } from "~/lib/cdr/format";
import { cn } from "~/lib/cn";
import { routes } from "~/lib/routes";
import { useRecordingList } from "../../_hooks/use-cdr-queries";
import {
	RANGE_PRESET_LABELS,
	RANGE_PRESETS,
	useTimeRangeState,
} from "../../cdr/_components/time-range";
import { RecordingPlayer } from "./recording-player";
import type { RecordingRow } from "~/lib/cdr/contracts";

const KINDS = ["", "call", "voicemail", "conference"] as const;

/**
 * Recordings.
 *
 * ## Why it is a sibling of call history rather than a column on it
 *
 * A recording does not map one-to-one onto a leg: a pause-and-resume produces two objects for one
 * leg, a voicemail greeting has no leg at all, and a conference recording belongs to a room. So
 * `recordings` is its own table with its own lifecycle (retention purges the OBJECT and keeps the
 * row as a tombstone) and its own screen. Call history links into it through the leg; this screen
 * is how you find media when you do not already have the call.
 *
 * ## Purged rows are shown, not hidden
 *
 * The API hides tombstones by default and this screen offers a toggle. Both are right: the common
 * question is "what can I listen to", and the audit question — "was there a recording of that call
 * and what happened to it" — has no other answer. A tombstone renders with no play button and the
 * date its media was purged, which is the whole content of the row.
 */
export function RecordingsScreen() {
	const range = useTimeRangeState();
	const searchId = useId();
	const kindId = useId();

	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [kind, setKind] = useQueryState(
		"kind",
		parseAsStringLiteral(KINDS).withDefault("").withOptions({ clearOnDefault: true }),
	);

	const [cursors, setCursors] = useState<readonly string[]>([]);
	const cursor = cursors[cursors.length - 1];

	const query = useMemo(
		() => ({
			from: range.from,
			to: range.to,
			kind: kind.length > 0 ? kind : undefined,
			search: search.length > 0 ? search : undefined,
			limit: DEFAULT_CDR_LIMIT,
			cursor,
		}),
		[range.from, range.to, kind, search, cursor],
	);

	const list = useRecordingList(query);
	const resetPaging = (): void => setCursors([]);

	return (
		<>
			<PageHeader
				title="Recordings"
				description="Call, voicemail and conference media. Playback and download links are signed and expire within minutes, so they are never shareable by accident."
			/>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<label htmlFor="rec-range" className="text-xs font-medium text-muted-foreground">
						Time range
					</label>
					<select
						id="rec-range"
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
							<label htmlFor="rec-from" className="text-xs font-medium text-muted-foreground">
								From
							</label>
							<input
								id="rec-from"
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
							<label htmlFor="rec-to" className="text-xs font-medium text-muted-foreground">
								To
							</label>
							<input
								id="rec-to"
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
						placeholder="Object key"
						className={inputClassName}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label htmlFor={kindId} className="text-xs font-medium text-muted-foreground">
						Kind
					</label>
					<select
						id={kindId}
						value={kind}
						onChange={(event) => {
							void setKind(event.target.value as (typeof KINDS)[number]);
							resetPaging();
						}}
						className={cn(inputClassName, "w-40 pr-8")}
					>
						<option value="">All</option>
						<option value="call">Call</option>
						<option value="voicemail">Voicemail</option>
						<option value="conference">Conference</option>
					</select>
				</div>
			</div>

			<RecordingsTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || kind.length > 0}
			/>

			<div className="flex items-center justify-end gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={cursors.length === 0}
					onClick={() => setCursors((current) => current.slice(0, -1))}
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
						}
					}}
				>
					Older
				</Button>
			</div>

			<p className="max-w-prose text-xs text-muted-foreground">
				Looking for the call a recording belongs to? Open{" "}
				<Link href={routes.cdr} className="text-primary underline-offset-4 hover:underline">
					call history
				</Link>{" "}
				and expand the call — every leg shows its own media.
			</p>

			{/*
			 * The retention column shows the window each row was STAMPED with when it was written, not
			 * the policy in force now — the two differ for every recording made before the policy last
			 * changed, which is why the link says "for new recordings" rather than "the policy".
			 */}
			<p className="max-w-prose text-xs text-muted-foreground">
				The retention column is the window each recording was stamped with when it was written.
				Changing{" "}
				<Link
					href={routes.recordingSettings}
					className="text-primary underline-offset-4 hover:underline"
				>
					how long recordings are kept
				</Link>{" "}
				applies to new recordings and never re-stamps these. Deleting one removes the audio
				immediately and leaves the row behind as a record that it existed.
			</p>
		</>
	);
}

function RecordingsTable({
	rows,
	isPending,
	filtered,
}: {
	rows: readonly RecordingRow[];
	isPending: boolean;
	filtered: boolean;
}) {
	if (isPending) {
		return <LoadingPanel label="Loading recordings" />;
	}
	if (rows.length === 0) {
		return filtered ? (
			<EmptyState
				title="Nothing matched"
				description="No recordings match the current filters in this time range."
			/>
		) : (
			<EmptyState
				icon={<RecordIcon className="size-5" />}
				title="No recordings in this time range"
				description="Recordings appear here once a call with recording enabled completes. Try a wider time range."
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Recordings, newest first</caption>
				<TableHeader>
					<TableRow>
						<TableHead>Recorded</TableHead>
						<TableHead>Kind</TableHead>
						<TableHead className="text-right">Length</TableHead>
						<TableHead className="text-right">Size</TableHead>
						<TableHead>Retention</TableHead>
						<TableHead>Media</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id}>
							<TableCell className="whitespace-nowrap" data-tabular>
								{new Date(row.createdAt).toLocaleString()}
							</TableCell>
							<TableCell>
								<Badge tone={row.kind === "voicemail" ? "accent" : "neutral"}>{row.kind}</Badge>
							</TableCell>
							<TableCell className="text-right whitespace-nowrap" data-tabular>
								{formatDuration(row.durationMs)}
							</TableCell>
							<TableCell className="text-right whitespace-nowrap" data-tabular>
								{formatBytes(row.sizeBytes)}
							</TableCell>
							<TableCell className="text-sm text-muted-foreground whitespace-nowrap">
								{row.deletedAt !== null
									? "Purged"
									: row.retentionUntil === null
										? "Kept"
										: `Until ${new Date(row.retentionUntil).toLocaleDateString()}`}
							</TableCell>
							<TableCell>
								<RecordingPlayer recording={row} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	);
}
