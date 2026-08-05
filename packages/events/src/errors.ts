import type { z } from "zod";

/**
 * Package-level errors. Per the oikos naming convention (`plans/reference/oikos-conventions.md`
 * §3) a package raises `…Error`; the HTTP boundary in `apps/*` is what turns one into an
 * `…Exception`.
 */

/** An event payload failed its Zod schema. */
export class EventValidationError extends Error {
	readonly subject: string | undefined;
	readonly eventType: string | undefined;
	readonly issues: readonly z.core.$ZodIssue[];

	constructor(
		message: string,
		options: {
			readonly subject?: string;
			readonly eventType?: string;
			readonly issues: readonly z.core.$ZodIssue[];
		},
	) {
		super(message);
		this.name = "EventValidationError";
		this.subject = options.subject;
		this.eventType = options.eventType;
		this.issues = options.issues;
	}

	/** One line per issue, `path: message` — safe to log without dumping the payload. */
	get summary(): string {
		return this.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
	}
}

/** A subject is outside the taxonomy, so no schema can be selected for it. */
export class UnknownEventSubjectError extends Error {
	readonly subject: string;

	constructor(subject: string) {
		super(
			`No event schema is registered for subject ${JSON.stringify(subject)}. ` +
				"Either the subject is outside the taxonomy or it is a newer MAJOR version.",
		);
		this.name = "UnknownEventSubjectError";
		this.subject = subject;
	}
}

/** Builds an {@link EventValidationError} from a failed `safeParse`. */
export function validationErrorFrom(
	label: string,
	error: z.ZodError,
	context: { readonly subject?: string; readonly eventType?: string } = {},
): EventValidationError {
	const issues = error.issues;
	const detail = issues
		.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
		.join("; ");
	return new EventValidationError(`${label} failed validation: ${detail}`, { ...context, issues });
}
