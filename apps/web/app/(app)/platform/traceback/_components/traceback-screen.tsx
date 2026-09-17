"use client";

import { parseAsString, useQueryState } from "nuqs";
import { useId, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { LedgerIcon } from "~/components/ui/icons";
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
import { cn } from "~/lib/cn";
import { tracebackCsvHref } from "~/lib/platform/client";
import {
	KYC_DECISION_LABELS,
	KYC_DECISION_TONES,
	TRACEBACK_MAX_RANGE_DAYS,
	TRACEBACK_MAX_ROWS,
	tracebackQueryIssue,
	type TracebackEntry,
} from "~/lib/platform/contracts";
import { useTraceback } from "../../../_hooks/use-platform-queries";

/**
 * Answering an industry traceback: *this number called this number, around then — who originated
 * it, and who is your customer?*
 *
 * ## Why it is a form with a submit rather than a live-filtering table
 *
 * Every read of `/platform/traceback` is an unpoliced cross-tenant read of call history and writes
 * an audit row for exactly that reason. A table that refetched on every keystroke would fill the
 * ledger with rows for questions nobody asked, and the ledger is what replaces row-level security
 * on this surface. So the query is held until somebody presses the button, and the button is what
 * `enabled` on the hook keys off.
 *
 * ## The two refusals are checked here, before the request
 *
 * A window wider than {@link TRACEBACK_MAX_RANGE_DAYS} and a query naming no number are both 400s
 * from the API. Mirrored client-side on the reasoning the audit log states for its own range: a 400
 * empties the table, and an empty table reads as "there were no such calls" — the opposite of "I
 * will not run that". The server still refuses them; this only keeps the request from being made.
 *
 * ## Two attestation pairs, labelled apart
 *
 * `Carrier claimed` is what arrived in the inbound `Identity` header; `We attested` is what this
 * platform decided on the way out. A traceback form asks about both and conflating them is how a
 * provider ends up answering the wrong question to a regulator — so the columns are separated and
 * headed with whose claim they are.
 */
const DEFAULT_WINDOW_DAYS = 7;

function defaultRange(): { readonly from: string; readonly to: string } {
	const to = new Date();
	const from = new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
	return { from: toLocalInput(from), to: toLocalInput(to) };
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time, with no zone and no seconds. */
function toLocalInput(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The API takes ISO with an offset; the control gives local wall time. */
function toIso(local: string): string {
	const parsed = new Date(local);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function TracebackScreen() {
	const initial = useMemo(defaultRange, []);
	const fromId = useId();
	const toId = useId();
	const calledId = useId();
	const callingId = useId();
	const trunkId = useId();

	const [from, setFrom] = useQueryState(
		"from",
		parseAsString.withDefault(initial.from).withOptions({ clearOnDefault: false }),
	);
	const [to, setTo] = useQueryState(
		"to",
		parseAsString.withDefault(initial.to).withOptions({ clearOnDefault: false }),
	);
	const [calledNumber, setCalledNumber] = useQueryState(
		"called",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [callingNumber, setCallingNumber] = useQueryState(
		"calling",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [trunk, setTrunk] = useQueryState(
		"trunk",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);

	const issue = tracebackQueryIssue({ from, to, calledNumber, callingNumber });

	const query = useMemo(
		() => ({
			from: toIso(from),
			to: toIso(to),
			calledNumber: calledNumber.trim().length > 0 ? calledNumber.trim() : undefined,
			callingNumber: callingNumber.trim().length > 0 ? callingNumber.trim() : undefined,
			trunkId: trunk.trim().length > 0 ? trunk.trim() : undefined,
			limit: TRACEBACK_MAX_ROWS,
		}),
		[from, to, calledNumber, callingNumber, trunk],
	);

	/**
	 * The query that has actually been ASKED, which is not the one in the form.
	 *
	 * Held separately so that editing a filter does not re-run the search and does not write another
	 * audit row: the answer on the screen stays the answer to the question that was submitted, and
	 * the CSV link downloads that same answer rather than whatever the boxes now say.
	 */
	const [submitted, setSubmitted] = useState<typeof query | null>(null);
	const result = useTraceback(submitted ?? query, { enabled: submitted !== null });

	const rows = result.data?.data ?? [];

	return (
		<>
			<PageHeader
				title="Traceback"
				description="Who originated a call, and who our customer was. Crosses every tenant, answers within the 24-hour duty, and records every question asked in the change ledger."
			/>

			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (issue === undefined) {
						setSubmitted(query);
					}
				}}
			>
				<Filter label="From" htmlFor={fromId}>
					<input
						id={fromId}
						type="datetime-local"
						value={from}
						onChange={(event) => void setFrom(event.target.value)}
						className={cn(inputClassName, "w-56")}
					/>
				</Filter>
				<Filter label="To" htmlFor={toId}>
					<input
						id={toId}
						type="datetime-local"
						value={to}
						onChange={(event) => void setTo(event.target.value)}
						className={cn(inputClassName, "w-56")}
					/>
				</Filter>
				<Filter label="Called number" htmlFor={calledId} description="Exact, never partial.">
					<input
						id={calledId}
						type="text"
						value={calledNumber}
						onChange={(event) => void setCalledNumber(event.target.value)}
						placeholder="+12125550100"
						className={cn(inputClassName, "w-48")}
					/>
				</Filter>
				<Filter
					label="Calling number"
					htmlFor={callingId}
					description="The number presented as caller ID."
				>
					<input
						id={callingId}
						type="text"
						value={callingNumber}
						onChange={(event) => void setCallingNumber(event.target.value)}
						placeholder="+442079460001"
						className={cn(inputClassName, "w-48")}
					/>
				</Filter>
				<Filter label="Trunk" htmlFor={trunkId} description="Optional. A trunk id.">
					<input
						id={trunkId}
						type="text"
						value={trunk}
						onChange={(event) => void setTrunk(event.target.value)}
						placeholder="0193f2aa-…"
						className={cn(inputClassName, "w-52")}
					/>
				</Filter>
				<Button type="submit" variant="primary" loading={result.isFetching}>
					Search
				</Button>
				<Button
					type="button"
					variant="secondary"
					disabled={submitted === null || rows.length === 0}
					onClick={() => {
						if (submitted !== null) {
							window.location.assign(tracebackCsvHref(submitted));
						}
					}}
				>
					Download CSV
				</Button>
			</form>

			{issue === undefined ? null : (
				<p role="alert" className="text-xs text-danger">
					{issue}
				</p>
			)}

			{submitted === null ? (
				<EmptyState
					icon={<LedgerIcon className="size-5" />}
					title="Nothing asked yet"
					description={`Name at least one number and a window of no more than ${String(TRACEBACK_MAX_RANGE_DAYS)} days, then search. Nothing is queried — and nothing is written to the ledger — until you do.`}
				/>
			) : result.isPending ? (
				<LoadingPanel label="Searching the call ledger" />
			) : rows.length === 0 ? (
				<EmptyState
					title="No legs matched"
					description="No call in this window carried that number, on any tenant. Both number filters are exact matches, and a call recorded outside the window is not found by widening the other filter."
				/>
			) : (
				<>
					{result.data?.truncated === true ? (
						<output className="block text-xs text-warning">
							This answer stops at {TRACEBACK_MAX_ROWS} legs and is a prefix of the real one. Narrow
							the window or name both ends of the call before you send it to anybody.
						</output>
					) : null}
					<TracebackTable rows={rows} />
				</>
			)}

			<p className="text-xs text-muted-foreground">
				Every search here reads across tenant boundaries and is recorded in the change ledger under
				your own organization — that record is the evidence the 24-hour response duty was met.
			</p>
		</>
	);
}

function Filter({
	label,
	htmlFor,
	description,
	children,
}: {
	label: string;
	htmlFor: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
				{label}
			</label>
			{children}
			{description === undefined ? null : (
				<span className="text-[0.6875rem] text-muted-foreground">{description}</span>
			)}
		</div>
	);
}

function TracebackTable({ rows }: { rows: readonly TracebackEntry[] }) {
	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Call legs matching this traceback, newest first</caption>
				<TableHeader>
					<TableRow>
						<TableHead>When</TableHead>
						<TableHead>Originating customer</TableHead>
						<TableHead>From</TableHead>
						<TableHead>To</TableHead>
						<TableHead>Carrier claimed</TableHead>
						<TableHead>We attested</TableHead>
						<TableHead>Signalling</TableHead>
						<TableHead>Outcome</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{/*
						Keyed by POSITION, which is the exception this file has to make.

						A traceback row is one LEG and the projection carries no leg id — the columns are
						chosen to be exactly what a traceback answer contains, and a row identifier is not
						among them. Two legs of one call can share `callId`, `startedAt` and both numbers
						(an A-leg and its B-leg written in the same millisecond do), so every composite key
						available here can collide. The list is a frozen answer to a submitted query and is
						never sorted, filtered or appended in place, so the index is stable for as long as
						it is rendered.
					*/}
					{rows.map((row, index) => (
						<TableRow key={`${String(index)}-${row.callId}`}>
							<TableCell className="whitespace-nowrap text-sm" data-tabular>
								{new Date(row.startedAt).toLocaleString()}
								<span title={row.callId} className="block font-mono text-xs text-muted-foreground">
									{row.callId.slice(0, 8)}…
								</span>
							</TableCell>
							<TableCell className="text-sm">
								{row.organizationName ?? row.organizationId.slice(0, 8)}
								{row.kycDecision === null ? (
									<span className="block text-xs text-muted-foreground">no KYC file</span>
								) : (
									<Badge tone={KYC_DECISION_TONES[row.kycDecision]} className="mt-1">
										{KYC_DECISION_LABELS[row.kycDecision]}
									</Badge>
								)}
							</TableCell>
							<TableCell className="font-mono text-sm" data-tabular>
								{row.fromNumber ?? "—"}
							</TableCell>
							<TableCell className="font-mono text-sm" data-tabular>
								{row.toNumber ?? "—"}
							</TableCell>
							<TableCell className="text-sm">
								{row.sipAttestation ?? "—"}
								{row.sipVerstat === null ? null : (
									<span className="block text-xs text-muted-foreground">{row.sipVerstat}</span>
								)}
							</TableCell>
							<TableCell className="text-sm">
								{row.expectedAttestation ?? "—"}
								{row.callerIdRightToUse === null ? null : (
									<span className="block text-xs text-muted-foreground">
										{row.callerIdRightToUse}
									</span>
								)}
							</TableCell>
							<TableCell className="text-sm text-muted-foreground">
								{row.signalingAddress ?? "—"}
								{row.sipCallId === null ? null : (
									<span title={row.sipCallId} className="block font-mono text-xs">
										{row.sipCallId.slice(0, 12)}…
									</span>
								)}
							</TableCell>
							<TableCell className="text-sm whitespace-nowrap">
								{row.disposition ?? "—"}
								{row.durationMs === null ? null : (
									<span className="block text-xs text-muted-foreground" data-tabular>
										{Math.round(row.durationMs / 1000)}s
									</span>
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	);
}
