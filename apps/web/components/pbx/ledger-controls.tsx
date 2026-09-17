"use client";

import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useCallback, useId, useMemo, useState } from "react";
import { cn } from "~/lib/cn";
import {
	LEDGER_RANGE_PRESETS,
	LEDGER_RANGE_PRESET_LABELS,
	cursorPageNumber,
	currentCursor,
	popCursor,
	pushCursor,
	resolveLedgerRange,
	type CursorStack,
	type LedgerRangePreset,
} from "~/lib/pbx/ledger";
import { Button } from "../ui/button";
import { inputClassName } from "../ui/field";
import type { ReactNode } from "react";

/**
 * The controls both screens over an append-only ledger share: the window, the filter row, and the
 * cursor pager.
 *
 * `lib/pbx/ledger.ts` states the maths and the stack transitions and is pure; this file is the
 * React half of the same claim — the hooks that put those values in the URL and in component state,
 * and the three pieces of markup that render them. Keeping the markup here rather than in each
 * screen's `_components` is what makes "two ledgers that page identically" true rather than
 * aspirational: the attack log and the change ledger are the same surface on the server precisely
 * so a reader has one thing to learn, and two hand-rolled pagers would be two places for an
 * off-by-one to hide.
 *
 * It deliberately does NOT wrap the table. The two ledgers have nothing in common column by column
 * — one is a diff of a configuration row, the other is a refused registration — and a shared table
 * shell would be a component with two disjoint sets of props.
 */

// ---------------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------------

export interface LedgerRangeState {
	readonly preset: LedgerRangePreset;
	readonly setPreset: (value: LedgerRangePreset) => void;
	/** `YYYY-MM-DDTHH:mm`, the value a `datetime-local` input round trips. */
	readonly customFrom: string;
	readonly setCustomFrom: (value: string) => void;
	readonly customTo: string;
	readonly setCustomTo: (value: string) => void;
	/** ISO instants to send. `undefined` lets the server apply its own default. */
	readonly from: string | undefined;
	readonly to: string | undefined;
}

/**
 * The window, held in the URL.
 *
 * The preset is carried as a PRESET rather than resolved to timestamps, for the reason the
 * reporting area records: `range=30d` means "the last month" to whoever opens the link, where a
 * resolved pair would mean "that particular month" forever. Support conversations want the first.
 *
 * The consequence is that a preset window would move on every render, which makes a cursor
 * meaningless — page two would be computed against a different window than page one, so rows could
 * repeat or vanish. `useMemo` pins it: within one browsing session the window is a fixed pair of
 * instants, and it only moves when the user changes the control, which is also when paging resets.
 *
 * `defaultPreset` differs per ledger — thirty days for the change ledger, seven for the attack log —
 * because the SERVER's defaults differ, and a control that showed "Last 30 days" while the server
 * applied seven would be a filter lying about itself.
 */
export function useLedgerRangeState(defaultPreset: LedgerRangePreset): LedgerRangeState {
	const [preset, setPresetState] = useQueryState(
		"range",
		parseAsStringLiteral(LEDGER_RANGE_PRESETS)
			.withDefault(defaultPreset)
			.withOptions({ clearOnDefault: true }),
	);
	const [customFrom, setCustomFromState] = useQueryState(
		"from",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [customTo, setCustomToState] = useQueryState(
		"to",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);

	const resolved = useMemo(
		() => resolveLedgerRange(preset, { from: customFrom, to: customTo }, new Date()),
		[preset, customFrom, customTo],
	);

	return {
		preset,
		setPreset: (value) => {
			void setPresetState(value);
		},
		customFrom,
		setCustomFrom: (value) => {
			void setCustomFromState(value);
		},
		customTo,
		setCustomTo: (value) => {
			void setCustomToState(value);
		},
		from: resolved.from,
		to: resolved.to,
	};
}

/**
 * The preset selector, and the two datetime inputs the `custom` mode reveals.
 *
 * `onChange` fires on every edit rather than only on the preset, because every one of them
 * invalidates the cursor: a keyset handle points into a result set, and changing the window
 * produces a different one.
 */
export function LedgerRangeControl({
	range,
	onChange,
	issue,
}: {
	range: LedgerRangeState;
	onChange: () => void;
	/** A window the server will refuse, said beside the control rather than sent and caught. */
	issue?: string | undefined;
}) {
	const presetId = useId();
	const fromId = useId();
	const toId = useId();

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={presetId} className="text-xs font-medium text-muted-foreground">
						Time range
					</label>
					<select
						id={presetId}
						value={range.preset}
						onChange={(event) => {
							range.setPreset(event.target.value as LedgerRangePreset);
							onChange();
						}}
						className={cn(inputClassName, "w-44 pr-8")}
					>
						{LEDGER_RANGE_PRESETS.map((preset) => (
							<option key={preset} value={preset}>
								{LEDGER_RANGE_PRESET_LABELS[preset]}
							</option>
						))}
					</select>
				</div>

				{range.preset === "custom" ? (
					<>
						<div className="flex flex-col gap-1.5">
							<label htmlFor={fromId} className="text-xs font-medium text-muted-foreground">
								From
							</label>
							<input
								id={fromId}
								type="datetime-local"
								value={range.customFrom}
								onChange={(event) => {
									range.setCustomFrom(event.target.value);
									onChange();
								}}
								className={inputClassName}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor={toId} className="text-xs font-medium text-muted-foreground">
								To
							</label>
							<input
								id={toId}
								type="datetime-local"
								value={range.customTo}
								onChange={(event) => {
									range.setCustomTo(event.target.value);
									onChange();
								}}
								className={inputClassName}
							/>
						</div>
					</>
				) : null}
			</div>

			{issue ? (
				<p role="alert" className="max-w-prose text-xs text-danger">
					{issue}
				</p>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The filter row
// ---------------------------------------------------------------------------------------------

/**
 * One labelled control in a ledger's filter row.
 *
 * The same markup `ListToolbar` uses for the CRUD lists, factored out because a ledger's filters
 * are neither a search box nor an enabled tri-state — they are four to six exact-match controls
 * over indexed columns, and there is no free-text search to put in the toolbar's first slot.
 */
export function LedgerFilterField({
	label,
	htmlFor,
	description,
	className,
	children,
}: {
	label: string;
	htmlFor: string;
	/** One line under the control, for a filter whose exactness is surprising. */
	description?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
				{label}
			</label>
			{children}
			{description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------------------------

export interface LedgerCursorState {
	/** The cursor to send, or `undefined` on the first page. */
	readonly cursor: string | undefined;
	readonly stack: CursorStack;
	readonly page: number;
	readonly older: (nextCursor: string | null) => void;
	readonly newer: () => void;
	/** Any filter change: a cursor into the previous result set means nothing in the next one. */
	readonly reset: () => void;
}

/**
 * Where the reader is, held in COMPONENT state rather than in the URL.
 *
 * The one deliberate exception to this app's "filters live in the query string" rule, and the
 * reporting area makes the same one: sharing a FILTER is useful, sharing somebody else's position
 * inside a result set is not — a link carrying page four's cursor opens on rows the recipient has
 * no context for, in a window that has since moved.
 */
export function useLedgerCursor(): LedgerCursorState {
	const [stack, setStack] = useState<CursorStack>([]);

	const older = useCallback((nextCursor: string | null) => {
		setStack((current) => pushCursor(current, nextCursor));
	}, []);
	const newer = useCallback(() => {
		setStack((current) => popCursor(current));
	}, []);
	const reset = useCallback(() => {
		setStack([]);
	}, []);

	return {
		cursor: currentCursor(stack),
		stack,
		page: cursorPageNumber(stack),
		older,
		newer,
		reset,
	};
}

/**
 * "Newer / Older", the page number, and the window the server says it applied.
 *
 * There is no "of 47" and there cannot be: the envelope carries no `total`, because a `count(*)`
 * over a table that takes a row for every mutation forever is the exact cost the cursor exists to
 * avoid. Saying which page you are on is honest; implying how many there are is not.
 *
 * The echoed range is rendered rather than the requested one. The server DEFAULTS an absent window
 * and returns what it applied, and a defaulted filter the user cannot see is the thing that makes
 * "why is my change missing?" unanswerable.
 */
export function LedgerPager({
	cursor,
	nextCursor,
	range,
	noun,
}: {
	cursor: LedgerCursorState;
	nextCursor: string | null;
	/** The window the server echoed back, once it has answered. */
	range: { readonly from: string; readonly to: string } | undefined;
	/** Plural, lower case: "changes", "attempts". */
	noun: string;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<p className="text-xs text-muted-foreground">
				{range
					? `Showing ${noun} from ${new Date(range.from).toLocaleString()} to ${new Date(range.to).toLocaleString()}.`
					: null}
			</p>
			<div className="flex items-center gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={cursor.stack.length === 0}
					onClick={() => cursor.newer()}
				>
					Newer
				</Button>
				<span className="text-xs text-muted-foreground" data-tabular>
					Page {cursor.page}
				</span>
				<Button
					size="sm"
					variant="secondary"
					disabled={nextCursor === null}
					onClick={() => cursor.older(nextCursor)}
				>
					Older
				</Button>
			</div>
		</div>
	);
}
