/**
 * Validation failures belong on the control that caused them, not in a toast: a corner overlay
 * shows one problem of many, never moves focus, and leaves no path back to the field. These
 * helpers turn a schema result into per-field messages and put the caret on the first control
 * that needs attention.
 */

interface IssueLike {
	readonly message: string;
	readonly path: readonly PropertyKey[];
}

export type FieldErrors<TName extends string> = Partial<Record<TName, string>>;

/**
 * First message per field, keyed by the top-level path segment. Later issues on the same field
 * are dropped — a control shows one requirement at a time.
 */
export function collectFieldErrors<TName extends string>(
	issues: readonly IssueLike[],
): FieldErrors<TName> {
	const errors: Record<string, string> = {};
	for (const issue of issues) {
		const [key] = issue.path;
		if (typeof key !== "string" || errors[key]) {
			continue;
		}
		errors[key] = issue.message;
	}
	return errors as FieldErrors<TName>;
}

/**
 * Moves focus to the first control in `order` that is failing. Field names double as element ids,
 * which is what makes `<FieldLabel htmlFor>` line up with this.
 */
export function focusFirstInvalidField<TName extends string>(
	order: readonly TName[],
	errors: FieldErrors<TName>,
): void {
	const target = order.find((name) => errors[name]);
	if (!target) {
		return;
	}
	document.getElementById(target)?.focus();
}

/**
 * First message from a TanStack Form field's error list, whatever shape the validator produced.
 * Exported so forms that lay their controls out by hand render the same message a field wrapper
 * would.
 */
export function getFieldErrorMessage(errors: readonly unknown[] | undefined): string | undefined {
	const [error] = errors ?? [];
	if (!error) {
		return undefined;
	}
	if (typeof error === "string") {
		return error;
	}
	if (typeof error === "object" && "message" in error) {
		const { message } = error as { message?: unknown };
		if (typeof message === "string") {
			return message;
		}
	}
	return String(error);
}
