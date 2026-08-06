import { z } from "zod";
import { UnknownEventSubjectError, validationErrorFrom } from "./errors";
import { auditEventSchema } from "./schemas/audit-events";
import { callEventSchema } from "./schemas/call-events";
import { cdrEventSchema } from "./schemas/cdr-events";
import { provisionEventSchema } from "./schemas/provision-events";
import { queueEventSchema } from "./schemas/queue-events";
import { registrationEventSchema } from "./schemas/registration-events";
import { voicemailEventSchema } from "./schemas/voicemail-events";
import { parseSubject, type EventFamily } from "./subjects";
import type { EventValidationError } from "./errors";

/**
 * Subject → schema resolution and validation. Pure: no I/O, no broker, no connection.
 *
 * Application code (a NestJS `@EventPattern` handler, a raw JetStream durable consumer, a Go
 * service after codegen) decodes the transport frame however its transport works and then calls
 * {@link validateEvent} with the delivered subject and the decoded payload.
 */

/** The one schema that validates every event of a family. */
export const EVENT_SCHEMAS_BY_FAMILY = {
	call: callEventSchema,
	registration: registrationEventSchema,
	queue: queueEventSchema,
	voicemail: voicemailEventSchema,
	cdr: cdrEventSchema,
	audit: auditEventSchema,
	provision: provisionEventSchema,
} as const satisfies Record<EventFamily, z.ZodType>;

export type EventSchemasByFamily = typeof EVENT_SCHEMAS_BY_FAMILY;

/** Any envelope this package knows how to validate. */
export const anyEventSchema = z.union([
	callEventSchema,
	registrationEventSchema,
	queueEventSchema,
	voicemailEventSchema,
	cdrEventSchema,
	auditEventSchema,
	provisionEventSchema,
]);

export type AnyEventEnvelope = z.infer<typeof anyEventSchema>;

/** The envelope type carried on a given family's subjects. */
export type EventEnvelopeOfFamily<TFamily extends EventFamily> = z.infer<
	EventSchemasByFamily[TFamily]
>;

/** Returns the schema that validates events on `subject`, or `undefined` if there is none. */
export function eventSchemaForSubject(subject: string): z.ZodType | undefined {
	const parsed = parseSubject(subject);
	if (parsed === undefined || parsed.kind === "rpc") {
		return undefined;
	}
	return EVENT_SCHEMAS_BY_FAMILY[parsed.family];
}

/** Options shared by {@link validateEvent} and {@link safeValidateEvent}. */
export interface ValidateEventOptions {
	/**
	 * Also assert that the envelope's own `subject` and `orgId` agree with the subject the
	 * message was delivered on. Defaults to `true`.
	 *
	 * This catches the two mistakes that survive schema validation and are miserable to debug:
	 * an event published on the wrong subject, and — the tenancy one — an envelope whose `orgId`
	 * is not the org in its subject, which would let a consumer scope a write to the wrong
	 * tenant.
	 */
	readonly crossCheckSubject?: boolean;
}

function crossCheck(
	subject: string,
	envelope: AnyEventEnvelope,
): { readonly path: string; readonly message: string } | undefined {
	if (envelope.subject !== subject) {
		return {
			path: "subject",
			message: `envelope subject ${JSON.stringify(envelope.subject)} does not match the delivery subject ${JSON.stringify(subject)}`,
		};
	}
	const parsed = parseSubject(subject);
	if (parsed !== undefined && parsed.kind !== "rpc" && parsed.orgId !== envelope.orgId) {
		return {
			path: "orgId",
			message: `envelope orgId ${JSON.stringify(envelope.orgId)} does not match the subject's org token ${JSON.stringify(parsed.orgId)}`,
		};
	}
	return undefined;
}

export type ValidateEventResult =
	| { readonly success: true; readonly data: AnyEventEnvelope }
	| { readonly success: false; readonly error: EventValidationError | UnknownEventSubjectError };

/**
 * Validates a decoded payload against the schema selected by its subject, without throwing.
 * Prefer this on the consume path: a poison message should be terminated and logged, never
 * allowed to become an unhandled rejection in a message callback.
 */
export function safeValidateEvent(
	subject: string,
	payload: unknown,
	options: ValidateEventOptions = {},
): ValidateEventResult {
	const schema = eventSchemaForSubject(subject);
	if (schema === undefined) {
		return { success: false, error: new UnknownEventSubjectError(subject) };
	}

	const result = schema.safeParse(payload);
	if (!result.success) {
		const eventType =
			typeof payload === "object" && payload !== null && "type" in payload
				? String((payload as { type: unknown }).type)
				: undefined;
		return {
			success: false,
			error: validationErrorFrom("Event", result.error, { subject, eventType }),
		};
	}

	const envelope = result.data as AnyEventEnvelope;
	if (options.crossCheckSubject !== false) {
		const mismatch = crossCheck(subject, envelope);
		if (mismatch !== undefined) {
			return {
				success: false,
				error: validationErrorFrom(
					"Event",
					new z.ZodError([
						{ code: "custom", path: [mismatch.path], message: mismatch.message, input: payload },
					]),
					{ subject, eventType: envelope.type },
				),
			};
		}
	}

	return { success: true, data: envelope };
}

/**
 * Validates a decoded payload against the schema selected by its subject.
 *
 * @throws {UnknownEventSubjectError} when the subject is outside the taxonomy.
 * @throws {EventValidationError} when the payload does not satisfy its schema.
 */
export function validateEvent(
	subject: string,
	payload: unknown,
	options: ValidateEventOptions = {},
): AnyEventEnvelope {
	const result = safeValidateEvent(subject, payload, options);
	if (!result.success) {
		throw result.error;
	}
	return result.data;
}

/**
 * Narrowing helper: validates and asserts the event belongs to `family`, so the caller gets the
 * family's discriminated union rather than the union of every family.
 */
export function validateEventOfFamily<TFamily extends EventFamily>(
	family: TFamily,
	subject: string,
	payload: unknown,
	options: ValidateEventOptions = {},
): EventEnvelopeOfFamily<TFamily> {
	const parsed = parseSubject(subject);
	if (parsed === undefined || parsed.kind === "rpc" || parsed.family !== family) {
		throw new UnknownEventSubjectError(subject);
	}
	return validateEvent(subject, payload, options) as EventEnvelopeOfFamily<TFamily>;
}
