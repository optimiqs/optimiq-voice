"use client";

import { useQuery } from "@tanstack/react-query";
import { useActiveOrganization } from "~/app/(app)/_context/session-context";
import { listPbx, listPrompts, PBX_RESOURCES, type PbxResourceDescriptor } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { Field, FieldDescription, FieldLabel, Select } from "../ui/field";
import type { ReactNode } from "react";
import type { PromptKind } from "~/lib/pbx/contracts";

/**
 * Everything about a reference select that is NOT the query behind it.
 *
 * Two properties in here are the reason this is a shared shell rather than a copied block. The
 * first is the truncation admission: the API caps a page at 100 and a tenant may hold more rows than
 * that, so a control that silently showed the first hundred would be telling an operator that the
 * prompt they uploaded does not exist. The second is the preserved unknown value: a stored id the
 * list does not hold is kept as its own option instead of being rewritten to whichever row happens
 * to be first, because a select whose value silently changes on render turns "open the dialog and
 * press Save" into a configuration edit nobody made.
 *
 * Both are one line of JSX and both are trivial to lose in a copy, which is the whole argument for
 * there being exactly one of each.
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
	options: readonly { readonly id: string; readonly label: string }[];
	/** How many rows the server holds, which is not how many are offered here. */
	total: number;
	loading: boolean;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	allowEmpty: boolean;
	emptyLabel: string;
	disabled?: boolean;
	error?: string;
	className?: string;
}) {
	const missing = value.length > 0 && !options.some((option) => option.id === value);

	return (
		<Field name={id} className={className}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
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
				{options.map((option) => (
					<option key={option.id} value={option.id}>
						{option.label}
					</option>
				))}
				{/* A value the list does not hold is kept, never silently rewritten to the first option. */}
				{missing ? <option value={value}>Currently: {value.slice(0, 8)}…</option> : null}
			</Select>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			{error ? (
				<p id={`${id}-error`} role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
			{total > options.length ? (
				<FieldDescription>
					Showing the first {options.length} of {total}.
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

	const query = useQuery({
		queryKey: queryKeys.pbxList(organizationId, resource.key, {
			page: 1,
			limit: 100,
			search: null,
			enabled: enabledOnly ? true : null,
			purpose: "resource-select",
		}),
		queryFn: () =>
			listPbx(resource, { page: 1, limit: 100, ...(enabledOnly ? { enabled: true } : {}) }),
		enabled: organizationId.length > 0,
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

	const query = useQuery({
		queryKey: queryKeys.promptList(organizationId, {
			page: 1,
			limit: 100,
			kind,
			purpose: "prompt-select",
		}),
		queryFn: () => listPrompts({ page: 1, limit: 100, kind }),
		enabled: organizationId.length > 0,
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

	const query = useQuery({
		queryKey: queryKeys.pbxList(organizationId, resource.key, {
			page: 1,
			limit: 100,
			search: null,
			enabled: true,
			purpose: "resource-ordered-list",
		}),
		queryFn: () => listPbx(resource, { page: 1, limit: 100, enabled: true }),
		enabled: organizationId.length > 0,
	});

	const rows = query.data?.data ?? [];
	const byId = new Map(rows.map((row) => [row.id, row]));
	const available = rows.filter((row) => !value.includes(row.id));

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
						const row = byId.get(entryId);
						return (
							<li
								key={entryId}
								className="flex items-center gap-2 rounded-field border border-border bg-surface px-3 py-1.5 text-sm"
							>
								<span className="w-5 text-xs text-muted-foreground" data-tabular>
									{index + 1}.
								</span>
								<span className="min-w-0 flex-1 truncate">
									{row ? resource.displayName(row) : `${entryId.slice(0, 8)}… (not found)`}
								</span>
								<button
									type="button"
									disabled={disabled || index === 0}
									onClick={() => move(index, -1)}
									className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover disabled:opacity-40"
									aria-label={`Move ${row ? resource.displayName(row) : "entry"} up`}
								>
									Up
								</button>
								<button
									type="button"
									disabled={disabled || index === value.length - 1}
									onClick={() => move(index, 1)}
									className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover disabled:opacity-40"
									aria-label={`Move ${row ? resource.displayName(row) : "entry"} down`}
								>
									Down
								</button>
								<button
									type="button"
									disabled={disabled}
									onClick={() => onChange(value.filter((candidate) => candidate !== entryId))}
									className="rounded px-1.5 py-0.5 text-xs text-danger hover:bg-danger-subtle"
									aria-label={`Remove ${row ? resource.displayName(row) : "entry"}`}
								>
									Remove
								</button>
							</li>
						);
					})}
				</ol>
			) : null}
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
							? `Every ${resource.label} is already listed`
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
