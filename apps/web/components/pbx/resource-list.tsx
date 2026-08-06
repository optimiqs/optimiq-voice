"use client";

import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { DEFAULT_PAGE_LIMIT, type PbxListQuery } from "~/lib/pbx/client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { inputClassName } from "../ui/field";
import { LoadingPanel } from "../ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import type { ReactNode } from "react";

/**
 * The list surface every PBX entity shares: URL state, search, filter, paging, empty state.
 *
 * ## Why the query state lives in the URL
 *
 * A support conversation about a phone system is "look at extension 2043" — which has to be a
 * link. Search text and page number in component state make that link impossible, break the back
 * button, and lose the user's place every time a dialog closes. `nuqs` puts them in the query
 * string, which is also the only way a refresh keeps the view the user was looking at.
 *
 * ## Why paging is server-side
 *
 * The API is paginated and capped at 100 per page — deliberately, "never unbounded" — so there is
 * no client-side page to fall back to. `total` and `totalPages` come from a `count(*) over ()` on
 * the same query as the rows, so the count and the page can never describe different snapshots.
 */

const ENABLED_FILTERS = ["all", "enabled", "disabled"] as const;
type EnabledFilter = (typeof ENABLED_FILTERS)[number];

/**
 * Search, filter and page, held in the query string.
 *
 * Changing the search or the filter resets to page 1: staying on page 7 of a result set that now
 * has two pages shows an empty table and reads as "no results", which is the wrong answer to a
 * search that matched two rows.
 */
export function useListQueryState(prefix = ""): {
	readonly query: PbxListQuery;
	readonly search: string;
	readonly setSearch: (value: string) => void;
	readonly enabledFilter: EnabledFilter;
	readonly setEnabledFilter: (value: EnabledFilter) => void;
	readonly page: number;
	readonly setPage: (value: number) => void;
} {
	const [search, setSearchState] = useQueryState(
		`${prefix}q`,
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [enabledFilter, setEnabledFilterState] = useQueryState(
		`${prefix}state`,
		parseAsStringLiteral(ENABLED_FILTERS).withDefault("all").withOptions({ clearOnDefault: true }),
	);
	const [page, setPage] = useQueryState(
		`${prefix}page`,
		parseAsInteger.withDefault(1).withOptions({ clearOnDefault: true }),
	);

	const debounced = useDebounced(search, 250);

	const query = useMemo<PbxListQuery>(
		() => ({
			page,
			limit: DEFAULT_PAGE_LIMIT,
			search: debounced.length > 0 ? debounced : undefined,
			enabled: enabledFilter === "all" ? undefined : enabledFilter === "enabled",
		}),
		[page, debounced, enabledFilter],
	);

	return {
		query,
		search,
		setSearch: (value: string) => {
			void setSearchState(value);
			void setPage(1);
		},
		enabledFilter,
		setEnabledFilter: (value: EnabledFilter) => {
			void setEnabledFilterState(value);
			void setPage(1);
		},
		page,
		setPage: (value: number) => {
			void setPage(value);
		},
	};
}

/**
 * Delays the value the QUERY uses, never the value the input shows.
 *
 * Debouncing the input itself would make typing feel laggy; debouncing only what reaches the
 * network keeps the field instant and still costs one request per pause.
 */
function useDebounced<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer.current);
	}, [value, delayMs]);

	return settled;
}

export interface ListToolbarProps {
	search: string;
	onSearchChange: (value: string) => void;
	enabledFilter: EnabledFilter;
	onEnabledFilterChange: (value: EnabledFilter) => void;
	searchPlaceholder: string;
	/** The create button, already permission-gated by the caller. */
	action?: ReactNode;
	className?: string;
}

export function ListToolbar({
	search,
	onSearchChange,
	enabledFilter,
	onEnabledFilterChange,
	searchPlaceholder,
	action,
	className,
}: ListToolbarProps) {
	const searchId = useId();
	const filterId = useId();

	return (
		<div className={cn("flex flex-wrap items-end gap-3", className)}>
			<div className="flex min-w-56 flex-1 flex-col gap-1.5">
				<label htmlFor={searchId} className="text-xs font-medium text-muted-foreground">
					Search
				</label>
				<input
					id={searchId}
					type="search"
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder={searchPlaceholder}
					className={inputClassName}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={filterId} className="text-xs font-medium text-muted-foreground">
					State
				</label>
				<select
					id={filterId}
					value={enabledFilter}
					onChange={(event) => onEnabledFilterChange(event.target.value as EnabledFilter)}
					className={cn(inputClassName, "w-36 pr-8")}
				>
					<option value="all">All</option>
					<option value="enabled">Enabled</option>
					<option value="disabled">Disabled</option>
				</select>
			</div>
			{action ? <div className="ml-auto">{action}</div> : null}
		</div>
	);
}

/**
 * Page N of M, with the range the user is looking at.
 *
 * "1–20 of 137" rather than only "page 2 of 7": the first tells someone scanning for a row
 * whether they have passed it, which the second cannot.
 */
export function ListPagination({
	page,
	limit,
	total,
	totalPages,
	onPageChange,
	className,
}: {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
	onPageChange: (page: number) => void;
	className?: string;
}) {
	if (total === 0) {
		return null;
	}
	const first = (page - 1) * limit + 1;
	const last = Math.min(total, page * limit);

	return (
		<div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
			<p className="text-xs text-muted-foreground" data-tabular>
				{first}–{last} of {total}
			</p>
			<div className="flex items-center gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={page <= 1}
					onClick={() => onPageChange(page - 1)}
				>
					Previous
				</Button>
				<span className="text-xs text-muted-foreground" data-tabular>
					Page {page} of {Math.max(1, totalPages)}
				</span>
				<Button
					size="sm"
					variant="secondary"
					disabled={page >= totalPages}
					onClick={() => onPageChange(page + 1)}
				>
					Next
				</Button>
			</div>
		</div>
	);
}

export interface ResourceTableColumn<TRow> {
	readonly key: string;
	readonly header: ReactNode;
	readonly cell: (row: TRow) => ReactNode;
	readonly className?: string;
	readonly headerClassName?: string;
}

/**
 * The table body every list shares, including the three states a list can be in.
 *
 * "No rows yet" and "no rows matched your search" are different situations and get different
 * copy: offering a create button to someone whose search simply missed is unhelpful, and telling
 * someone with an empty phone system to "try a different search" is worse.
 */
export function ResourceTable<TRow extends { readonly id: string }>({
	rows,
	columns,
	isPending,
	emptyTitle,
	emptyDescription,
	emptyAction,
	filtered,
	rowActions,
	caption,
}: {
	rows: readonly TRow[];
	columns: readonly ResourceTableColumn<TRow>[];
	isPending: boolean;
	emptyTitle: string;
	emptyDescription: string;
	emptyAction?: ReactNode;
	/** True when a search or filter is narrowing the list, which changes the empty copy. */
	filtered: boolean;
	rowActions?: (row: TRow) => ReactNode;
	caption?: string;
}) {
	if (isPending) {
		return <LoadingPanel label={`Loading ${emptyTitle.toLowerCase()}`} />;
	}

	if (rows.length === 0) {
		return filtered ? (
			<EmptyState
				title="Nothing matched"
				description="No rows match the current search and filter. Clear them to see everything."
			/>
		) : (
			<EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
		);
	}

	return (
		<TableContainer>
			<Table>
				{caption ? <caption className="sr-only">{caption}</caption> : null}
				<TableHeader>
					<TableRow>
						{columns.map((column) => (
							<TableHead key={column.key} className={column.headerClassName}>
								{column.header}
							</TableHead>
						))}
						{rowActions ? (
							<TableHead className="w-0">
								<span className="sr-only">Actions</span>
							</TableHead>
						) : null}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id}>
							{columns.map((column) => (
								<TableCell key={column.key} className={column.className}>
									{column.cell(row)}
								</TableCell>
							))}
							{rowActions ? (
								<TableCell className="text-right whitespace-nowrap">{rowActions(row)}</TableCell>
							) : null}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	);
}

/** The enabled/disabled pill every list shows, so "off" reads the same everywhere. */
export function EnabledBadge({ enabled }: { enabled: boolean }) {
	return <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</Badge>;
}
