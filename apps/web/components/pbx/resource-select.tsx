"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useActiveOrganization } from "~/app/(app)/_context/session-context";
import { listPbx, listPrompts, PBX_RESOURCES, type PbxResourceDescriptor } from "~/lib/pbx/client";
import {
	mergeSelectedOption,
	PICKER_PAGE_LIMIT,
	pickerSearchTerm,
	type PickerOption,
} from "~/lib/pbx/picker";
import { queryKeys } from "~/lib/query-keys";
import { Field, FieldDescription, FieldLabel, Input, Select } from "../ui/field";
import { useDebounced } from "./use-debounced";
import type { ReactNode } from "react";
import type { PromptKind } from "~/lib/pbx/contracts";

/** The same pause the list toolbar uses, so a picker and a table feel like one control. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Everything about a reference select that is NOT the query behind it.
 *
 * Three properties in here are the reason this is a shared shell rather than a copied block.
 *
 * The first is the search box: the API caps a page at 100, so without one a tenant holding more
 * rows than that would be told the prompt they uploaded does not exist. The term is debounced and
 * sent to the server as `?search=`, so the hundred rows on offer are the hundred that MATCH.
 *
 * The second is the preserved value: a stored id the current page does not hold is kept as its own
 * option instead of being rewritten to whichever row happens to be first, because a select whose
 * value silently changes on render turns "open the dialog and press Save" into a configuration edit
 * nobody made. Searching makes this the common case rather than the odd one, which is why the shell
 * also remembers the labels of rows it has already seen — see `lib/pbx/picker.ts`.
 *
 * The third is the truncation admission that remains once both of those exist: a search narrow
 * enough still matching more than a page says so, rather than hiding it.
 */
function ReferenceSelectShell({
	id,
	label,
	description,
	options,
	total,
	loading,
	value,
	onChange,
	search,
	onSearchChange,
	searchPlaceholder,
	placeholder,
	allowEmpty,
	emptyLabel,
	disabled,
	error,
	className,
}: {
	id: string;
	label: string;
	description?: ReactNode;
	options: readonly PickerOption[];
	/** How many rows the server holds for the CURRENT search, which is not how many are offered. */
	total: number;
	loading: boolean;
	value: string;
	onChange: (value: string) => void;
	search: string;
	onSearchChange: (value: string) => void;
	searchPlaceholder: string;
	placeholder: string;
	allowEmpty: boolean;
	emptyLabel: string;
	disabled?: boolean;
	error?: string;
	className?: string;
}) {
	// Every row this picker has offered, so the selected one keeps its real label after the page it
	// came from has been replaced by a search result. State rather than a ref, because learning a
	// label has to REDRAW the option that was showing a truncated id; the guard is what stops that
	// becoming a loop — a page teaching nothing new sets nothing. Bounded by the rows the operator
	// has actually searched past, a handful of pages of a hundred at worst.
	const [seen, setSeen] = useState<ReadonlyMap<string, string>>(() => new Map());
	useEffect(() => {
		const learned = options.filter((option) => seen.get(option.id) !== option.label);
		if (learned.length === 0) {
			return;
		}
		setSeen((previous) => {
			const next = new Map(previous);
			for (const option of learned) {
				next.set(option.id, option.label);
			}
			return next;
		});
	}, [options, seen]);

	const offered = mergeSelectedOption(
		options,
		value,
		seen,
		(id) => `Currently: ${id.slice(0, 8)}…`,
	);

	return (
		<Field name={id} className={className}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			{/*
			 * Not a `<label>`: the field's label belongs to the select, and a second one here would
			 * give the control two accessible names. `aria-label` says what the box does instead.
			 */}
			<Input
				type="search"
				value={search}
				onChange={(event) => onSearchChange(event.target.value)}
				disabled={disabled}
				placeholder={searchPlaceholder}
				aria-label={`Search ${label.toLowerCase()}`}
				aria-controls={id}
			/>
			<Select
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				disabled={disabled || loading}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
			>
				{allowEmpty ? (
					<option value="">{loading ? "Loading…" : emptyLabel}</option>
				) : (
					<option value="" disabled>
						{loading ? "Loading…" : placeholder}
					</option>
				)}
				{/*
				 * A value the current page does not hold is merged in, never silently rewritten to the
				 * first option — with its remembered label when the picker has seen the row before.
				 */}
				{offered.map((option) => (
					<option key={option.id} value={option.id}>
						{option.label}
					</option>
				))}
			</Select>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			{error ? (
				<p id={`${id}-error`} role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
			{total > options.length ? (
				<FieldDescription>
					Showing the first {options.length} of {total}. Search to narrow the list.
				</FieldDescription>
			) : null}
		</Field>
	);
}

/**
 * A select over another resource's rows, for the plain foreign keys that are not destinations.
 *
 * `inbound_route.phone_number_id`, `inbound_route.time_condition_id` and the trunk list on an
 * outbound route are real columns pointing at one known table — unlike a destination, whose
 * target table varies by row. They need a picker, not the destination trio, and the difference is
 * worth keeping visible: a destination asks "where does the call go?", this asks "which row?".
 *
 * Capped at the API's maximum page, and the cap is stated rather than hidden.
 */
export function ResourceSelect<TRow extends { readonly id: string }>({
	id,
	label,
	description,
	resource,
	value,
	onChange,
	placeholder,
	allowEmpty = true,
	emptyLabel = "None",
	disabled,
	error,
	className,
	enabledOnly = true,
}: {
	id: string;
	label: string;
	description?: ReactNode;
	resource: PbxResourceDescriptor<TRow>;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	allowEmpty?: boolean;
	emptyLabel?: string;
	disabled?: boolean;
	error?: string;
	className?: string;
	/** Disabled rows are hidden by default — choosing one is almost always a mistake. */
	enabledOnly?: boolean;
}) {
	const organizationId = useActiveOrganization()?.id ?? "";
	const [search, setSearch] = useState("");
	const term = pickerSearchTerm(useDebounced(search, SEARCH_DEBOUNCE_MS));

	const query = useQuery({
		queryKey: queryKeys.pbxList(organizationId, resource.key, {
			page: 1,
			limit: PICKER_PAGE_LIMIT,
			search: term ?? null,
			enabled: enabledOnly ? true : null,
			purpose: "resource-select",
		}),
		queryFn: () =>
			listPbx(resource, {
				page: 1,
				limit: PICKER_PAGE_LIMIT,
				...(term === undefined ? {} : { search: term }),
				...(enabledOnly ? { enabled: true } : {}),
			}),
		enabled: organizationId.length > 0,
		// The previous page stays on screen while the next search resolves, so the select does not
		// empty itself between keystrokes.
		placeholderData: (previous) => previous,
	});

	const rows = query.data?.data ?? [];

	return (
		<ReferenceSelectShell
			id={id}
			label={label}
			description={description}
			options={rows.map((row) => ({ id: row.id, label: resource.displayName(row) }))}
			total={query.data?.total ?? 0}
			loading={query.isPending}
			value={value}
			onChange={onChange}
			search={search}
			onSearchChange={setSearch}
			searchPlaceholder={`Search ${resource.label}…`}
			placeholder={placeholder ?? `Choose a ${resource.label}…`}
			allowEmpty={allowEmpty}
			emptyLabel={emptyLabel}
			disabled={disabled}
			error={error}
			className={className}
		/>
	);
}

/**
 * A select over the PROMPT library, which {@link ResourceSelect} cannot express.
 *
 * Two facts about `/prompts` put it outside the generic list machinery, and neither is worth
 * bending that machinery for. It takes a `kind` filter that `PbxListQuery` has no vocabulary for,
 * and `prompt` has no `enabled` column at all — so `ResourceSelect`'s default of `?enabled=true`
 * would be a query parameter the server does not model, silently narrowing nothing today and
 * meaning something else the day it does. Hence a separate query, a separate key factory
 * (`queryKeys.promptList`), and the same shell as everything else on the form.
 *
 * `kind` defaults to `prompt` because that is what a form on a queue, a ring group or an IVR menu is
 * choosing: `moh` files are reached through the class that owns them and never picked individually,
 * and `greeting` rows belong to a mailbox and are managed from it.
 */
export function PromptSelect({
	id,
	label,
	description,
	value,
	onChange,
	kind = "prompt",
	placeholder,
	allowEmpty = true,
	emptyLabel = "None",
	disabled,
	error,
	className,
}: {
	id: string;
	label: string;
	description?: ReactNode;
	value: string;
	onChange: (value: string) => void;
	/** Which shelf of the library to offer. Almost always the default. */
	kind?: PromptKind;
	placeholder?: string;
	allowEmpty?: boolean;
	emptyLabel?: string;
	disabled?: boolean;
	error?: string;
	className?: string;
}) {
	const organizationId = useActiveOrganization()?.id ?? "";
	const [search, setSearch] = useState("");
	const term = pickerSearchTerm(useDebounced(search, SEARCH_DEBOUNCE_MS));

	const query = useQuery({
		queryKey: queryKeys.promptList(organizationId, {
			page: 1,
			limit: PICKER_PAGE_LIMIT,
			search: term ?? null,
			kind,
			purpose: "prompt-select",
		}),
		queryFn: () =>
			listPrompts({
				page: 1,
				limit: PICKER_PAGE_LIMIT,
				...(term === undefined ? {} : { search: term }),
				kind,
			}),
		enabled: organizationId.length > 0,
		placeholderData: (previous) => previous,
	});

	const rows = query.data?.data ?? [];

	return (
		<ReferenceSelectShell
			id={id}
			label={label}
			description={description}
			options={rows.map((row) => ({ id: row.id, label: PBX_RESOURCES.prompts.displayName(row) }))}
			total={query.data?.total ?? 0}
			loading={query.isPending}
			value={value}
			onChange={onChange}
			search={search}
			onSearchChange={setSearch}
			searchPlaceholder="Search prompts…"
			placeholder={placeholder ?? "Choose a prompt…"}
			allowEmpty={allowEmpty}
			emptyLabel={emptyLabel}
			disabled={disabled}
			error={error}
			className={className}
		/>
	);
}

/**
 * An ordered multi-select over another resource — the trunk failover chain, and nothing else.
 *
 * Order is the whole meaning here (`trunk_priority` is tried in order), so this is a list with
 * add/remove/move rather than a `<select multiple>`, which has no order at all and which nobody
 * has ever operated correctly with a keyboard.
 */
export function ResourceOrderedList<TRow extends { readonly id: string }>({
	id,
	label,
	description,
	resource,
	value,
	onChange,
	disabled,
	error,
}: {
	id: string;
	label: string;
	description?: ReactNode;
	resource: PbxResourceDescriptor<TRow>;
	value: readonly string[];
	onChange: (value: readonly string[]) => void;
	disabled?: boolean;
	error?: string;
}) {
	const organizationId = useActiveOrganization()?.id ?? "";
	const [search, setSearch] = useState("");
	const term = pickerSearchTerm(useDebounced(search, SEARCH_DEBOUNCE_MS));

	const query = useQuery({
		queryKey: queryKeys.pbxList(organizationId, resource.key, {
			page: 1,
			limit: PICKER_PAGE_LIMIT,
			search: term ?? null,
			enabled: true,
			purpose: "resource-ordered-list",
		}),
		queryFn: () =>
			listPbx(resource, {
				page: 1,
				limit: PICKER_PAGE_LIMIT,
				...(term === undefined ? {} : { search: term }),
				enabled: true,
			}),
		enabled: organizationId.length > 0,
		placeholderData: (previous) => previous,
	});

	const page = query.data?.data;
	const rows = page ?? [];
	// The chain's own entries are named from what this control has already seen, not from the
	// current page — once a search is running the rows already in the chain are usually filtered
	// out of it, and "(not found)" for a trunk that plainly exists is a lie. Same state-not-ref
	// argument, and same no-op guard, as the shell above.
	const [seen, setSeen] = useState<ReadonlyMap<string, string>>(() => new Map());
	useEffect(() => {
		const learned = (page ?? [])
			.map((row) => [row.id, resource.displayName(row)] as const)
			.filter(([rowId, name]) => seen.get(rowId) !== name);
		if (learned.length === 0) {
			return;
		}
		setSeen((previous) => new Map([...previous, ...learned]));
	}, [page, resource, seen]);

	const chosen = new Set(value);
	const available = rows.filter((row) => !chosen.has(row.id));

	function move(index: number, delta: number): void {
		const next = [...value];
		const target = index + delta;
		const current = next[index];
		const swap = next[target];
		if (current === undefined || swap === undefined) {
			return;
		}
		next[index] = swap;
		next[target] = current;
		onChange(next);
	}

	return (
		<Field name={id} className="sm:col-span-2">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			{value.length > 0 ? (
				<ol className="flex flex-col gap-1">
					{value.map((entryId, index) => {
						const name = seen.get(entryId);
						return (
							<li
								key={entryId}
								className="flex items-center gap-2 rounded-field border border-border bg-surface px-3 py-1.5 text-sm"
							>
								<span className="w-5 text-xs text-muted-foreground" data-tabular>
									{index + 1}.
								</span>
								<span className="min-w-0 flex-1 truncate">
									{name ?? `${entryId.slice(0, 8)}… (not found)`}
								</span>
								<button
									type="button"
									disabled={disabled || index === 0}
									onClick={() => move(index, -1)}
									className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover disabled:opacity-40"
									aria-label={`Move ${name ?? "entry"} up`}
								>
									Up
								</button>
								<button
									type="button"
									disabled={disabled || index === value.length - 1}
									onClick={() => move(index, 1)}
									className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover disabled:opacity-40"
									aria-label={`Move ${name ?? "entry"} down`}
								>
									Down
								</button>
								<button
									type="button"
									disabled={disabled}
									onClick={() => onChange(value.filter((candidate) => candidate !== entryId))}
									className="rounded px-1.5 py-0.5 text-xs text-danger hover:bg-danger-subtle"
									aria-label={`Remove ${name ?? "entry"}`}
								>
									Remove
								</button>
							</li>
						);
					})}
				</ol>
			) : null}
			<Input
				type="search"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				disabled={disabled}
				placeholder={`Search ${resource.label}…`}
				aria-label={`Search ${resource.label}`}
				aria-controls={id}
			/>
			<Select
				id={id}
				value=""
				disabled={disabled || query.isPending || available.length === 0}
				onChange={(event) => {
					if (event.target.value) {
						onChange([...value, event.target.value]);
					}
				}}
				aria-invalid={error ? true : undefined}
			>
				<option value="">
					{query.isPending
						? "Loading…"
						: available.length === 0
							? term === undefined
								? `Every ${resource.label} is already listed`
								: "No match"
							: `Add a ${resource.label}…`}
				</option>
				{available.map((row) => (
					<option key={row.id} value={row.id}>
						{resource.displayName(row)}
					</option>
				))}
			</Select>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			{error ? (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
		</Field>
	);
}
