"use client";

import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useId, useMemo } from "react";
import {
	LedgerFilterField,
	LedgerPager,
	LedgerRangeControl,
	useLedgerCursor,
	useLedgerRangeState,
} from "~/components/pbx/ledger-controls";
import { Badge } from "~/components/ui/badge";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { ShieldIcon } from "~/components/ui/icons";
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
import { SIP_ACL_SCOPES, SIP_AUTH_EVENT_TYPES } from "~/lib/pbx/contracts";
import { DEFAULT_EVENT_LIMIT } from "~/lib/pbx/ledger";
import {
	SIP_ACL_SCOPE_LABELS,
	SIP_AUTH_EVENT_TYPE_LABELS,
	SIP_AUTH_EVENT_TYPE_TONES,
} from "~/lib/pbx/security-labels";
import { useSipAuthEvents } from "../../_hooks/use-ledger-queries";
import type { SipAuthEventRow } from "~/lib/pbx/contracts";

/**
 * Every authentication attempt the platform refused.
 *
 * ## Seven days, not thirty
 *
 * The window defaults to the SERVER's default (`DEFAULT_EVENT_RANGE_DAYS`), which is the one place
 * the two ledgers diverge and is a statement about what each is for: an attack log is read
 * operationally — something is happening now, or happened last night — while a change ledger is read
 * historically. A control showing "Last 30 days" while the server applied seven would be a filter
 * lying about itself, which is exactly what the echoed range under the table exists to prevent.
 *
 * ## No total, and no search
 *
 * The envelope carries `nextCursor` and no `total`, deliberately: this table grows fastest exactly
 * when somebody is reading it, and a `count(*)` over the window is the cost the keyset cursor exists
 * to avoid. Every filter is an EXACT match over an indexed column for the same reason — there is no
 * free-text box, because the only text worth matching is the user agent and an `ilike` over it is a
 * sequential scan of the window dressed up as a feature.
 *
 * `sourceIp` is an ADDRESS and not a network, which the server enforces and the description says:
 * `?sourceIp=0.0.0.0/0` would be a full scan spelled as a filter, and the question an operator
 * actually asks here is "what has THIS address been doing" — because that is the address they are
 * about to block.
 *
 * ## What this table cannot show
 *
 * `organization_id` is `NOT NULL` on the server, so an attempt against an account matching no tenant
 * has nowhere to be filed and is deliberately absent. Those are refused at the media server and
 * appear in its security log. The note under the table says so, because "no rows" on an attack log
 * is a claim worth qualifying.
 */
const EVENT_TYPE_OPTIONS = ["", ...SIP_AUTH_EVENT_TYPES] as const;
const SCOPE_OPTIONS = ["", ...SIP_ACL_SCOPES] as const;

export function AuthFailuresPanel() {
	// Prefixed nowhere: the range keys (`range`/`from`/`to`) are this tab's alone — the access-rules
	// tab prefixes its own list state with `acl` precisely so the two can share one URL.
	const range = useLedgerRangeState("7d");
	const cursor = useLedgerCursor();

	const eventTypeId = useId();
	const scopeId = useId();
	const sourceIpId = useId();
	const accountRefId = useId();

	const [eventType, setEventType] = useQueryState(
		"event",
		parseAsStringLiteral(EVENT_TYPE_OPTIONS).withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [scope, setScope] = useQueryState(
		"scope",
		parseAsStringLiteral(SCOPE_OPTIONS).withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [sourceIp, setSourceIp] = useQueryState(
		"ip",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [accountRef, setAccountRef] = useQueryState(
		"account",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);

	const query = useMemo(
		() => ({
			from: range.from,
			to: range.to,
			// `=== ""` rather than a length test, so the empty option narrows out of the literal union
			// instead of being widened back into it.
			eventType: eventType === "" ? undefined : eventType,
			scope: scope === "" ? undefined : scope,
			sourceIp: sourceIp.length > 0 ? sourceIp : undefined,
			accountRef: accountRef.length > 0 ? accountRef : undefined,
			limit: DEFAULT_EVENT_LIMIT,
			cursor: cursor.cursor,
		}),
		[range.from, range.to, eventType, scope, sourceIp, accountRef, cursor.cursor],
	);

	const list = useSipAuthEvents(query);

	const filtered =
		eventType.length > 0 || scope.length > 0 || sourceIp.length > 0 || accountRef.length > 0;

	return (
		<>
			<LedgerRangeControl range={range} onChange={cursor.reset} />

			<div className="flex flex-wrap items-end gap-3">
				<LedgerFilterField label="Refused because" htmlFor={eventTypeId}>
					<select
						id={eventTypeId}
						value={eventType}
						onChange={(event) => {
							void setEventType(event.target.value as (typeof EVENT_TYPE_OPTIONS)[number]);
							cursor.reset();
						}}
						className={cn(inputClassName, "w-48 pr-8")}
					>
						<option value="">All reasons</option>
						{SIP_AUTH_EVENT_TYPES.map((value) => (
							<option key={value} value={value}>
								{SIP_AUTH_EVENT_TYPE_LABELS[value]}
							</option>
						))}
					</select>
				</LedgerFilterField>

				<LedgerFilterField label="Surface" htmlFor={scopeId}>
					<select
						id={scopeId}
						value={scope}
						onChange={(event) => {
							void setScope(event.target.value as (typeof SCOPE_OPTIONS)[number]);
							cursor.reset();
						}}
						className={cn(inputClassName, "w-44 pr-8")}
					>
						<option value="">All surfaces</option>
						{SIP_ACL_SCOPES.map((value) => (
							<option key={value} value={value}>
								{SIP_ACL_SCOPE_LABELS[value]}
							</option>
						))}
					</select>
				</LedgerFilterField>

				<LedgerFilterField
					label="Source address"
					htmlFor={sourceIpId}
					description="One address, exactly — not a network."
				>
					<input
						id={sourceIpId}
						type="text"
						value={sourceIp}
						onChange={(event) => {
							void setSourceIp(event.target.value);
							cursor.reset();
						}}
						placeholder="198.51.100.7"
						className={cn(inputClassName, "w-44")}
					/>
				</LedgerFilterField>

				<LedgerFilterField
					label="Account"
					htmlFor={accountRefId}
					description="The extension, account or MAC that was attempted."
				>
					<input
						id={accountRefId}
						type="text"
						value={accountRef}
						onChange={(event) => {
							void setAccountRef(event.target.value);
							cursor.reset();
						}}
						placeholder="1001"
						className={cn(inputClassName, "w-40")}
					/>
				</LedgerFilterField>
			</div>

			<AuthFailuresTable rows={list.rows} isPending={list.isPending} filtered={filtered} />

			<LedgerPager
				cursor={cursor}
				nextCursor={list.nextCursor}
				range={list.range}
				noun="attempts"
			/>

			<p className="max-w-prose text-xs text-muted-foreground">
				This log records attempts that could be attributed to this organization. An attempt against
				an account matching no tenant has nowhere to be filed and is refused at the media server
				instead, so an empty table means "nothing aimed at you", not "nothing happened".
			</p>
		</>
	);
}

function AuthFailuresTable({
	rows,
	isPending,
	filtered,
}: {
	rows: readonly SipAuthEventRow[];
	isPending: boolean;
	filtered: boolean;
}) {
	if (isPending) {
		return <LoadingPanel label="Loading authentication failures" />;
	}
	if (rows.length === 0) {
		return filtered ? (
			<EmptyState
				title="Nothing matched"
				description="No refused attempts match the current filters in this time range. Widen the range or clear a filter."
			/>
		) : (
			<EmptyState
				icon={<ShieldIcon className="size-5" />}
				title="Nothing was refused in this time range"
				description="Refused registrations, trunk calls, provisioning fetches and API requests appear here as they happen. Try a wider time range if you expected to see something."
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Refused authentication attempts, newest first</caption>
				<TableHeader>
					<TableRow>
						<TableHead>When</TableHead>
						<TableHead>Refused because</TableHead>
						<TableHead>Surface</TableHead>
						<TableHead>Source</TableHead>
						<TableHead>Account</TableHead>
						<TableHead>Transport</TableHead>
						<TableHead>Agent</TableHead>
						<TableHead>Detail</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id}>
							<TableCell className="whitespace-nowrap" data-tabular>
								{new Date(row.occurredAt).toLocaleString()}
							</TableCell>
							<TableCell>
								<Badge tone={SIP_AUTH_EVENT_TYPE_TONES[row.eventType]}>
									{SIP_AUTH_EVENT_TYPE_LABELS[row.eventType]}
								</Badge>
							</TableCell>
							<TableCell className="text-sm text-foreground">
								{SIP_ACL_SCOPE_LABELS[row.scope]}
							</TableCell>
							<TableCell className="font-mono whitespace-nowrap">
								{row.sourceIp ?? <span className="font-sans text-muted-foreground">Unknown</span>}
							</TableCell>
							<TableCell className="font-mono whitespace-nowrap">
								{row.accountRef ?? <span className="font-sans text-muted-foreground">—</span>}
							</TableCell>
							<TableCell className="text-sm text-muted-foreground uppercase">
								{row.transport ?? "—"}
							</TableCell>
							{/*
							 * A user agent is a long, low-value string that identifies the handset model when
							 * it identifies anything. Truncated with the whole value in `title`, so a wide
							 * column cannot push the columns an operator reads off the screen.
							 */}
							<TableCell className="max-w-40 truncate text-sm text-muted-foreground">
								{row.userAgent ? <span title={row.userAgent}>{row.userAgent}</span> : "—"}
							</TableCell>
							<TableCell className="text-sm text-muted-foreground">
								<EventDetail detail={row.detail} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	);
}

/**
 * Whatever names the refusal: the matched ACL entry, the rate-limit window, the device id.
 *
 * Rendered as `key: value` pairs rather than as raw JSON. The shape varies by event type and is not
 * a contract this app can type against — so it is shown, honestly, as the loose bag it is, and
 * nested structures are stringified rather than expanded into a tree nobody would read in a table
 * cell.
 */
function EventDetail({ detail }: { detail: Readonly<Record<string, unknown>> | null }) {
	if (detail === null) {
		return <>—</>;
	}
	const entries = Object.entries(detail);
	if (entries.length === 0) {
		return <>—</>;
	}
	return (
		<dl className="flex flex-col gap-0.5">
			{entries.map(([key, value]) => (
				<div key={key} className="flex gap-1.5">
					<dt className="shrink-0 text-xs text-subtle-foreground">{key}</dt>
					<dd className="min-w-0 truncate font-mono text-xs">
						{typeof value === "string" ? value : JSON.stringify(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}
