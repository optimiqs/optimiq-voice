"use client";

import { Field as BaseField } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "~/lib/cn";
import { focusRing } from "./focus-ring";
import type { ComponentProps, ReactNode } from "react";

/**
 * Form field primitives over Base UI's Field.
 *
 * Base UI wires the label, the control, the description and the error to each other with the
 * `id` / `aria-describedby` / `aria-invalid` relationships already correct. Hand-rolling a
 * `<label>` + `<input>` pair is how those relationships get forgotten, so no form in this app
 * builds a control any other way.
 */

export const inputClassName = cn(
	"h-9 w-full rounded-field border border-border bg-surface px-3 text-sm text-foreground",
	"transition-colors duration-[--motion-fast] ease-[--ease-standard]",
	"placeholder:text-subtle-foreground",
	"hover:border-border-strong",
	"disabled:cursor-not-allowed disabled:opacity-60",
	"data-[invalid]:border-danger data-[invalid]:focus-visible:outline-danger",
	focusRing,
);

export function Field({ className, ...props }: ComponentProps<typeof BaseField.Root>) {
	return <BaseField.Root className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof BaseField.Label>) {
	return (
		<BaseField.Label className={cn("text-sm font-medium text-foreground", className)} {...props} />
	);
}

export function FieldDescription({
	className,
	...props
}: ComponentProps<typeof BaseField.Description>) {
	return (
		<BaseField.Description className={cn("text-xs text-muted-foreground", className)} {...props} />
	);
}

export function FieldError({ className, ...props }: ComponentProps<typeof BaseField.Error>) {
	return <BaseField.Error className={cn("text-xs text-danger", className)} {...props} />;
}

export function Input({ className, ...props }: ComponentProps<typeof BaseInput>) {
	return <BaseInput className={cn(inputClassName, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			className={cn(inputClassName, "min-h-20 resize-y py-2 leading-relaxed", className)}
			{...props}
		/>
	);
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
	return (
		<select className={cn(inputClassName, "pr-8", className)} {...props}>
			{children}
		</select>
	);
}

/**
 * A complete labelled control. `error` is a plain string rather than Base UI's validity state
 * because validation lives in the zod schema, not in the DOM's constraint API.
 */
export function FormField({
	label,
	description,
	error,
	name,
	children,
	className,
}: {
	label: string;
	description?: ReactNode;
	error?: string | undefined;
	name: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Field name={name} className={className}>
			<FieldLabel>{label}</FieldLabel>
			{children}
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			{error ? (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
		</Field>
	);
}
