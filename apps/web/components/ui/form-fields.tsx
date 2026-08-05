"use client";

import { getFieldErrorMessage } from "~/lib/forms/field-errors";
import { Field, FieldDescription, FieldLabel, Input, Select } from "./field";
import type { ReactNode } from "react";

/**
 * Form-library-agnostic field adapters.
 *
 * `FieldLike` is the narrow slice of a TanStack Form field these components actually use. Typing
 * against that rather than against `useForm`'s inferred field type keeps the design system from
 * depending on the form library's generics — and keeps a field renderable from a plain `useState`
 * in the one place that needs it.
 *
 * The error is shown only once the field has been touched: telling someone their empty email is
 * invalid before they have typed anything is noise, not help.
 */

type ValueUpdater<TValue> = TValue | ((previous: TValue) => TValue);

export interface FieldLike<TValue = string> {
	readonly name: string;
	readonly handleBlur: () => void;
	readonly handleChange: (updater: ValueUpdater<TValue>) => void;
	readonly state: {
		readonly value: TValue;
		readonly meta: { readonly errors?: readonly unknown[]; readonly isTouched?: boolean };
	};
}

interface BaseFieldProps {
	label: string;
	description?: ReactNode;
	required?: boolean;
	disabled?: boolean;
	className?: string;
	/** A message the server produced, shown when the client validator is happy. */
	submitError?: string | undefined;
}

function useFieldError<TValue>(
	field: FieldLike<TValue>,
	submitError: string | undefined,
): string | undefined {
	const live = field.state.meta.isTouched
		? getFieldErrorMessage(field.state.meta.errors)
		: undefined;
	return live ?? submitError;
}

export function TextField<TValue extends string = string>({
	field,
	label,
	description,
	required,
	disabled,
	className,
	submitError,
	type = "text",
	placeholder,
	autoComplete,
	autoFocus,
}: BaseFieldProps & {
	field: FieldLike<TValue>;
	type?: "text" | "email" | "password" | "tel" | "url";
	placeholder?: string;
	autoComplete?: string;
	autoFocus?: boolean;
}) {
	const error = useFieldError(field, submitError);
	const errorId = `${field.name}-error`;
	const descriptionId = `${field.name}-description`;

	return (
		<Field name={field.name} className={className}>
			<FieldLabel htmlFor={field.name}>
				{label}
				{required ? (
					<span aria-hidden="true" className="ml-0.5 text-danger">
						*
					</span>
				) : null}
			</FieldLabel>
			<Input
				id={field.name}
				type={type}
				value={field.state.value}
				onChange={(event) => field.handleChange(event.target.value as TValue)}
				onBlur={field.handleBlur}
				disabled={disabled}
				placeholder={placeholder}
				autoComplete={autoComplete}
				autoFocus={autoFocus}
				aria-required={required || undefined}
				aria-invalid={error ? true : undefined}
				aria-describedby={
					[description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(" ") ||
					undefined
				}
			/>
			{description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
			{error ? (
				<p id={errorId} role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
		</Field>
	);
}

export function SelectField<TValue extends string = string>({
	field,
	label,
	description,
	required,
	disabled,
	className,
	submitError,
	children,
}: BaseFieldProps & { field: FieldLike<TValue>; children: ReactNode }) {
	const error = useFieldError(field, submitError);
	const errorId = `${field.name}-error`;

	return (
		<Field name={field.name} className={className}>
			<FieldLabel htmlFor={field.name}>{label}</FieldLabel>
			<Select
				id={field.name}
				value={field.state.value}
				onChange={(event) => field.handleChange(event.target.value as TValue)}
				onBlur={field.handleBlur}
				disabled={disabled}
				aria-required={required || undefined}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
			>
				{children}
			</Select>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			{error ? (
				<p id={errorId} role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
		</Field>
	);
}
