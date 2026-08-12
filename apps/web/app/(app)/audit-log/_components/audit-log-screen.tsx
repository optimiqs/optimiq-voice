"use client";

import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { Fragment, useId, useMemo, useState } from "react";
import {
	LedgerFilterField,
	LedgerPager,
	LedgerRangeControl,
	useLedgerCursor,
	useLedgerRangeState,
} from "~/components/pbx/ledger-controls";
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
import {
	AUDIT_ACTOR_TYPE_LABELS,
	auditActorRef,
	auditFieldChanges,
	auditResourceLabel,
	auditValueText,
	shortId,
	splitAuditAction,
} from "~/lib/pbx/audit-format";
import { AUDIT_ACTOR_TYPES } from "~/lib/pbx/contracts";
import { DEFAULT_AUDIT_LIMIT, auditRangeIssue } from "~/lib/pbx/ledger";
import { useAuditLog } from "../../_hooks/use-ledger-queries";
import type { AuditLogEntryRow } from "~/lib/pbx/contracts";

/**
 * The change ledger: every mutation in this organization, newest first.
 *
 * ## Rows are ENTRIES; the expansion is the diff
 *
 * A ledger entry IS its detail — the changed columns, the actor, the request id are all on the list
 * row, which is why the server offers no `GET /:id` to call. So the expansion is a rendering of what
 * the row already carries rather than a second request: the table shows who changed what, and
 * opening a row shows which columns moved and to what.
 *
 * ## The window is thirty days by default and a year at most
 *
 * `audit_log` grows with every mutation in the tenant and is never pruned by the API, so an
 * unbounded listing is a table scan waiting for a large enough organization. The server defaults the
 * window and ECHOES back the one it applied, which the pager renders — a defaulted filter the user
 * cannot see is the thing that makes "why is my change missing?" unanswerable.
 *
 * The 366-day ceiling is checked HERE, before the request, because a 400 that empties the table
 * reads as "there is nothing here", which is the opposite of what a year-wide range means.
 *
 * ## Two actor filters, because there are two principals
 *
 * A person is `actor_user_id`; an API key or a service is `actor_ref`. Collapsing them into one
 * "actor" box would either require guessing which column a value belongs in, or make "everything
 * this key did" unaskable. Both are exact-match, like every other filter here: there is no free-text
 * search, because the only text worth matching is the user agent and the diff, and an `ilike` over
 * either is a sequential scan of the window dressed up as a feature.
 *
 * ## Nothing on this page can write
 *
 * `audit_log` is append-only in the database itself — the tenant role holds `SELECT, INSERT` under
 * two policies rather than one `FOR ALL` — so there is no delete control to hide behind a
 * permission and no endpoint behind one if there were.
 */
const ACTOR_TYPE_OPTIONS = ["", ...AUDIT_ACTOR_TYPES] as const;

export function AuditLogScreen() {
	const range = useLedgerRangeState("30d");
	const cursor = useLedgerCursor();

	const actorTypeId = useId();
	const actorUserId = useId();
	const actorRefId = useId();
	const actionId = useId();
	const resourceTypeId = useId();
	const resourceRefId = useId();

	const [actorType, setActorType] = useQueryState(
		"actor",
		parseAsStringLiteral(ACTOR_TYPE_OPTIONS).withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [actorUser, setActorUser] = useQueryState(
		"user",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [actorRef, setActorRef] = useQueryState(
		"key",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [action, setAction] = useQueryState(
		"action",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [resourceType, setResourceType] = useQueryState(
		"entity",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [resourceRef, setResourceRef] = useQueryState(
		"row",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);

	const rangeIssue = auditRangeIssue({ from: range.from, to: range.to });

	const query = useMemo(
		() => ({
			from: range.from,
			to: range.to,
			// `=== ""` rather than a length test, so the empty option narrows out of the literal union
			// instead of being widened back into it.
			actorType: actorType === "" ? undefined : actorType,
			actorUserId: actorUser.length > 0 ? actorUser : undefined,
			actorRef: actorRef.length > 0 ? actorRef : undefined,
			action: action.length > 0 ? action : undefined,
			resourceType: resourceType.length > 0 ? resourceType : undefined,
			resourceRef: resourceRef.length > 0 ? resourceRef : undefined,
			limit: DEFAULT_AUDIT_LIMIT,
			cursor: cursor.cursor,
		}),
		[
			range.from,
			range.to,
			actorType,
			actorUser,
			actorRef,
			action,
			resourceType,
			resourceRef,
			cursor.cursor,
		],
	);

	/**
	 * A range the server would refuse is never sent.
	 *
	 * Held back rather than fired and caught: the message is already beside the control, and letting
	 * the request go would replace the table the user is reading with an error state saying less than
	 * the sentence above it already does.
	 */
	const list = useAuditLog(query, { enabled: rangeIssue === undefined });

	const [expanded, setExpanded] = useState<string | null>(null);

	const resetPaging = (): void => {
		cursor.reset();
		setExpanded(null);
	};

	const filtered =
		actorType.length > 0 ||
		actorUser.length > 0 ||
		actorRef.length > 0 ||
		action.length > 0 ||
		resourceType.length > 0 ||
		resourceRef.length > 0;

	return (
		<>
			<PageHeader
				title="Audit log"
				description="Every change made in this organization, newest first: who made it, what it touched, and which columns moved."
			/>

			<LedgerRangeControl range={range} onChange={resetPaging} issue={rangeIssue} />

			<div className="flex flex-wrap items-end gap-3">
				<LedgerFilterField label="Acted as" htmlFor={actorTypeId}>
					<select
						id={actorTypeId}
						value={actorType}
						onChange={(event) => {
							void setActorType(event.target.value as (typeof ACTOR_TYPE_OPTIONS)[number]);
							resetPaging();
						}}
						className={cn(inputClassName, "w-36 pr-8")}
					>
						<option value="">Anyone</option>
						{AUDIT_ACTOR_TYPES.map((value) => (
							<option key={value} value={value}>
								{AUDIT_ACTOR_TYPE_LABELS[value]}
							</option>
						))}
					</select>
				</LedgerFilterField>

				<LedgerFilterField
					label="Person"
					htmlFor={actorUserId}
					description="A user id. Never matches an API key."
				>
					<input
						id={actorUserId}
						type="text"
						value={actorUser}
						onChange={(event) => {
							void setActorUser(event.target.value);
							resetPaging();
						}}
						placeholder="0193f2aa-0000-…"
						className={cn(inputClassName, "w-52")}
					/>
				</LedgerFilterField>

				<LedgerFilterField
					label="Key or service"
					htmlFor={actorRefId}
					description="An API key id or a service name. Never matches a person."
				>
					<input
						id={actorRefId}
						type="text"
						value={actorRef}
						onChange={(event) => {
							void setActorRef(event.target.value);
							resetPaging();
						}}
						placeholder="provisioner"
						className={cn(inputClassName, "w-44")}
					/>
				</LedgerFilterField>

				<LedgerFilterField
					label="Action"
					htmlFor={actionId}
					description="A dotted verb, exactly: extension.update."
				>
					<input
						id={actionId}
						type="text"
						value={action}
						onChange={(event) => {
							void setAction(event.target.value);
							resetPaging();
						}}
						placeholder="extension.update"
						className={cn(inputClassName, "w-48")}
					/>
				</LedgerFilterField>

				<LedgerFilterField
					label="Entity"
					htmlFor={resourceTypeId}
					description="A table name, exactly: extension."
				>
					<input
						id={resourceTypeId}
						type="text"
						value={resourceType}
						onChange={(event) => {
							void setResourceType(event.target.value);
							resetPaging();
						}}
						placeholder="extension"
						className={cn(inputClassName, "w-40")}
					/>
				</LedgerFilterField>

				<LedgerFilterField
					label="Row"
					htmlFor={resourceRefId}
					description="One row's whole history, by its id."
				>
					<input
						id={resourceRefId}
						type="text"
						value={resourceRef}
						onChange={(event) => {
							void setResourceRef(event.target.value);
							resetPaging();
						}}
						placeholder="0193f2aa-0000-…"
						className={cn(inputClassName, "w-52")}
					/>
				</LedgerFilterField>
			</div>

			<AuditLogTable
				rows={list.rows}
				isPending={list.isPending}
				filtered={filtered}
				expanded={expanded}
				onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
			/>

			<LedgerPager cursor={cursor} nextCursor={list.nextCursor} range={list.range} noun="changes" />

			<p className="max-w-prose text-xs text-muted-foreground">
				The change ledger is append-only: it can be read and never edited, by anyone, through any
				endpoint. Secret values are dropped from both sides of a diff before the entry is written,
				so a rotation is visible here and its value is not.
			</p>
		</>
	);
}

function AuditLogTable({
	rows,
	isPending,
	filtered,
	expanded,
	onToggle,
}: {
	rows: readonly AuditLogEntryRow[];
	isPending: boolean;
	filtered: boolean;
	expanded: string | null;
	onToggle: (id: string) => void;
}) {
	if (isPending) {
		return <LoadingPanel label="Loading the audit log" />;
	}
	if (rows.length === 0) {
		return filtered ? (
			<EmptyState
				title="Nothing matched"
				description="No changes match the current filters in this time range. Widen the range or clear a filter — every filter here is an exact match, including the action and the entity."
			/>
		) : (
			<EmptyState
				icon={<LedgerIcon className="size-5" />}
				title="No changes in this time range"
				description="Every create, edit and delete in this organization is recorded here as it happens. Try a wider time range if you expected to see something."
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<caption className="sr-only">Configuration changes, newest first</caption>
				<TableHeader>
					<TableRow>
						<TableHead>When</TableHead>
						<TableHead>Who</TableHead>
						<TableHead>Did</TableHead>
						<TableHead>To</TableHead>
						<TableHead>From</TableHead>
						<TableHead className="w-0">
							<span className="sr-only">Changes</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const { verb } = splitAuditAction(row.action);
						const actor = auditActorRef(row);
						const changes = auditFieldChanges(row);

						return (
							<Fragment key={row.id}>
								<TableRow>
									<TableCell className="whitespace-nowrap" data-tabular>
										{new Date(row.occurredAt).toLocaleString()}
									</TableCell>
									<TableCell>
										<Badge tone="neutral">{AUDIT_ACTOR_TYPE_LABELS[row.actorType]}</Badge>
										{actor ? (
											<span title={actor} className="block font-mono text-xs text-muted-foreground">
												{shortId(actor)}
											</span>
										) : null}
									</TableCell>
									<TableCell className="font-mono text-sm whitespace-nowrap">{verb}</TableCell>
									<TableCell className="text-sm text-foreground">
										{auditResourceLabel(row.resourceType)}
										{row.resourceRef ? (
											<span
												title={row.resourceRef}
												className="block font-mono text-xs text-muted-foreground"
											>
												{shortId(row.resourceRef)}
											</span>
										) : null}
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{row.ipAddress ?? "—"}
									</TableCell>
									<TableCell className="text-right whitespace-nowrap">
										{changes.length > 0 ? (
											<Button
												size="sm"
												variant="ghost"
												aria-expanded={expanded === row.id}
												onClick={() => onToggle(row.id)}
											>
												{expanded === row.id
													? "Hide changes"
													: `${String(changes.length)} ${changes.length === 1 ? "column" : "columns"}`}
											</Button>
										) : null}
									</TableCell>
								</TableRow>
								{expanded === row.id ? (
									<TableRow>
										<TableCell colSpan={6} className="bg-muted/30">
											<AuditEntryDetail entry={row} />
										</TableCell>
									</TableRow>
								) : null}
							</Fragment>
						);
					})}
				</TableBody>
			</Table>
		</TableContainer>
	);
}

/**
 * The columns one entry changed, and the request it belonged to.
 *
 * Rendered from the row rather than fetched: `before` and `after` are already the changed columns
 * only, diffed server-side inside the transaction of the mutation being recorded.
 *
 * The request id is here rather than in a column because it is worth nothing to a person scanning
 * the table and worth everything to whoever is joining this entry to a log line.
 */
function AuditEntryDetail({ entry }: { entry: AuditLogEntryRow }) {
	const changes = auditFieldChanges(entry);

	return (
		<div className="flex flex-col gap-3 py-2">
			<dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
				{changes.map((change) => (
					<Fragment key={change.field}>
						<dt className="font-mono text-xs text-muted-foreground">{change.field}</dt>
						<dd className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm">
							<span className="font-mono text-xs break-all text-muted-foreground line-through">
								{auditValueText(change.before)}
							</span>
							<span aria-hidden="true" className="text-xs text-subtle-foreground">
								→
							</span>
							<span className="font-mono text-xs break-all text-foreground">
								{auditValueText(change.after)}
							</span>
						</dd>
					</Fragment>
				))}
			</dl>

			<p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span>
					Action <span className="font-mono">{entry.action}</span>
				</span>
				{entry.requestId ? (
					<span>
						Request <span className="font-mono">{entry.requestId}</span>
					</span>
				) : null}
				{entry.userAgent ? <span className="min-w-0 truncate">{entry.userAgent}</span> : null}
			</p>
		</div>
	);
}
