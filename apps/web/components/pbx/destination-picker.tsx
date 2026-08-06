"use client";

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useActiveOrganization } from "~/app/(app)/_context/session-context";
import { listPbxRows } from "~/lib/pbx/client";
import {
	DESTINATION_TYPE_LABELS,
	destinationFieldNames,
	destinationKind,
	destinationTarget,
	selectableDestinationTypes,
	type DestinationPrefix,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { queryKeys } from "~/lib/query-keys";
import { Field, FieldDescription, FieldLabel, Input, Select } from "../ui/field";
import type { ReactNode } from "react";
import type { DestinationType } from "~/lib/pbx/contracts";

/**
 * One destination trio, as a control.
 *
 * Eleven trio sites across seven entities all mean the same thing — "where does the call go from
 * here?" — so there is one component, and its `prefix` says which slot of the row it is editing.
 * That is also what makes server errors land: `PBX_INVALID_DESTINATION` issues and compile
 * diagnostics name `timeoutDestinationRef`, and this component asks for its errors under exactly
 * that key.
 *
 * ## Why the shape changes with the type
 *
 * The trio is a tagged union in three columns, and the database enforces it with a check
 * constraint: an `entity` type needs a `ref` and must not carry a literal, a `value` type needs
 * `data.value` and must not carry a `ref`, `hangup` carries neither. Showing all three inputs at
 * once and letting the server reject the combination would make every user discover the rule by
 * failing. So the type select drives which input exists, and switching type clears the half that
 * no longer applies — in the value, not just visually, because a hidden field that still holds a
 * stale ref is the 422 the user cannot see the cause of.
 *
 * ## The entity picker is a live list
 *
 * It reads the same list endpoint the target's own page reads, through the same query keys, so
 * creating an extension in another tab and coming back shows it — no separate "options" endpoint
 * and no cache that can disagree with the table the user just looked at.
 */

export interface DestinationPickerProps {
	/** Which trio on the row this edits. `""` is the row's primary destination. */
	prefix: DestinationPrefix;
	label: string;
	description?: ReactNode;
	value: DestinationValue;
	onChange: (value: DestinationValue) => void;
	/** When false, "No destination" is offered and clears the trio. */
	required?: boolean;
	disabled?: boolean;
	/** Server messages keyed by the field names in {@link destinationFieldNames}. */
	errors?: Readonly<Record<string, string>>;
	className?: string;
}

export function DestinationPicker({
	prefix,
	label,
	description,
	value,
	onChange,
	required = false,
	disabled = false,
	errors = {},
	className,
}: DestinationPickerProps) {
	const names = destinationFieldNames(prefix);
	const typeId = names.type;
	const refId = names.ref;
	const dataId = names.data;

	const types = selectableDestinationTypes(value.type);
	const kind = value.type === null ? null : destinationKind(value.type);
	const target = value.type === null ? undefined : destinationTarget(value.type);

	const typeError = errors[names.type];
	const refError = errors[names.ref];
	const dataError = errors[names.data];

	/**
	 * Changing the type rewrites the whole trio rather than patching one key. Carrying a ref from
	 * `extension` over to `external` is precisely the "unexpected-ref" 422 the user did not cause.
	 */
	function selectType(next: string): void {
		if (next === "") {
			onChange({ type: null, ref: null, data: null });
			return;
		}
		const type = next as DestinationType;
		onChange({
			type,
			ref: null,
			// A hangup cause is the only payload worth preserving across a type change, and it is
			// only meaningful on hangup, so nothing is preserved.
			data: null,
		});
	}

	return (
		<fieldset className={className} disabled={disabled}>
			<legend className="text-sm font-medium text-foreground">{label}</legend>
			{description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}

			<div className="mt-2 grid gap-3 sm:grid-cols-2">
				<Field name={typeId}>
					<FieldLabel htmlFor={typeId} className="text-xs text-muted-foreground">
						Goes to
					</FieldLabel>
					<Select
						id={typeId}
						value={value.type ?? ""}
						onChange={(event) => selectType(event.target.value)}
						aria-invalid={typeError ? true : undefined}
						aria-describedby={typeError ? `${typeId}-error` : undefined}
					>
						{required ? (
							<option value="" disabled>
								Choose a destination…
							</option>
						) : (
							<option value="">No destination</option>
						)}
						{types.map((type) => (
							<option key={type} value={type}>
								{DESTINATION_TYPE_LABELS[type]}
							</option>
						))}
					</Select>
					{typeError ? (
						<p id={`${typeId}-error`} role="alert" className="text-xs text-danger">
							{typeError}
						</p>
					) : null}
				</Field>

				{kind === "entity" ? (
					<EntityRefField
						id={refId}
						type={value.type as DestinationType}
						value={value.ref}
						onChange={(ref) => onChange({ ...value, ref })}
						error={refError}
						unavailable={target === undefined}
					/>
				) : null}

				{kind === "value" ? (
					<Field name={dataId}>
						<FieldLabel htmlFor={dataId} className="text-xs text-muted-foreground">
							{value.type === "external" ? "Number to dial" : "Application name"}
						</FieldLabel>
						<Input
							id={dataId}
							value={value.data?.value ?? ""}
							onChange={(event) =>
								onChange({ ...value, ref: null, data: { value: event.target.value } })
							}
							placeholder={value.type === "external" ? "+12125550100" : "playback"}
							aria-invalid={dataError ? true : undefined}
							aria-describedby={dataError ? `${dataId}-error` : undefined}
						/>
						{dataError ? (
							<p id={`${dataId}-error`} role="alert" className="text-xs text-danger">
								{dataError}
							</p>
						) : null}
					</Field>
				) : null}

				{value.type === "hangup" ? (
					<Field name={dataId}>
						<FieldLabel htmlFor={dataId} className="text-xs text-muted-foreground">
							Hangup cause
						</FieldLabel>
						<Input
							id={dataId}
							value={value.data?.cause ?? ""}
							onChange={(event) =>
								onChange({
									...value,
									ref: null,
									data: event.target.value ? { cause: event.target.value } : null,
								})
							}
							placeholder="NORMAL_CLEARING"
						/>
						<FieldDescription>Optional. Q.850 cause the caller hears.</FieldDescription>
					</Field>
				) : null}
			</div>
		</fieldset>
	);
}

/**
 * The entity half of the trio: a select over the target resource's own list.
 *
 * Capped at the API's maximum page, and the cap is stated rather than hidden — an organization
 * with more than a hundred extensions needs a searchable picker, and silently truncating the list
 * would make the missing ones look deleted. That upgrade is a follow-up, not a lie told here.
 */
function EntityRefField({
	id,
	type,
	value,
	onChange,
	error,
	unavailable,
}: {
	id: string;
	type: DestinationType;
	value: string | null;
	onChange: (ref: string | null) => void;
	error?: string;
	unavailable: boolean;
}) {
	const organizationId = useActiveOrganization()?.id ?? "";
	const target = destinationTarget(type);
	const fallbackId = useId();

	const query = useQuery({
		queryKey: queryKeys.pbxList(organizationId, target?.key ?? "unavailable", {
			page: 1,
			limit: 100,
			search: null,
			enabled: true,
			purpose: "destination-picker",
		}),
		queryFn: () => listPbxRows(target?.path ?? "", { page: 1, limit: 100, enabled: true }),
		enabled: organizationId.length > 0 && target !== undefined,
	});

	if (unavailable || !target) {
		return (
			<Field name={id}>
				<FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
					Target
				</FieldLabel>
				<Input id={id} value={value ?? ""} readOnly aria-describedby={`${fallbackId}-note`} />
				<FieldDescription id={`${fallbackId}-note`}>
					{DESTINATION_TYPE_LABELS[type]}s have no management screen yet, so this id cannot be
					changed here.
				</FieldDescription>
			</Field>
		);
	}

	const rows = query.data?.data ?? [];
	const total = query.data?.total ?? 0;
	const missing = value !== null && !rows.some((row) => row.id === value);

	return (
		<Field name={id}>
			<FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
				Which {target.label}
			</FieldLabel>
			<Select
				id={id}
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
				disabled={query.isPending}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
			>
				<option value="" disabled>
					{query.isPending ? "Loading…" : `Choose a ${target.label}…`}
				</option>
				{rows.map((row) => (
					<option key={String(row.id)} value={String(row.id)}>
						{target.displayName(row)}
					</option>
				))}
				{/*
				 * A ref the list does not contain is kept selectable rather than dropped: it may be
				 * disabled, on a later page, or already dangling. Silently re-pointing it to the first
				 * option would be a routing change nobody asked for.
				 */}
				{missing ? (
					<option value={value}>Currently: {value.slice(0, 8)}… (not in this list)</option>
				) : null}
			</Select>
			{error ? (
				<p id={`${id}-error`} role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
			{total > rows.length ? (
				<FieldDescription>
					Showing the first {rows.length} of {total}. Enabled rows only.
				</FieldDescription>
			) : null}
		</Field>
	);
}
