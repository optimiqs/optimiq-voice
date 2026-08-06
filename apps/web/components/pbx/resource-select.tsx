"use client";

import { useQuery } from "@tanstack/react-query";
import { useActiveOrganization } from "~/app/(app)/_context/session-context";
import { listPbx, type PbxResourceDescriptor } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { Field, FieldDescription, FieldLabel, Select } from "../ui/field";
import type { ReactNode } from "react";

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
	const total = query.data?.total ?? 0;
	const missing = value.length > 0 && !rows.some((row) => row.id === value);

	return (
		<Field name={id} className={className}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				disabled={disabled || query.isPending}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
			>
				{allowEmpty ? (
					<option value="">{query.isPending ? "Loading…" : emptyLabel}</option>
				) : (
					<option value="" disabled>
						{query.isPending ? "Loading…" : (placeholder ?? `Choose a ${resource.label}…`)}
					</option>
				)}
				{rows.map((row) => (
					<option key={row.id} value={row.id}>
						{resource.displayName(row)}
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
			{total > rows.length ? (
				<FieldDescription>
					Showing the first {rows.length} of {total}.
				</FieldDescription>
			) : null}
		</Field>
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
