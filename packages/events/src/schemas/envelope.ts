import { z } from "zod";
import { createEntityId } from "@optimiq-voice/identifiers";
import { validationErrorFrom } from "../errors";
import type { EventFamily } from "../subjects";

/**
 * The base event envelope every subject on the backbone carries.
 *
 * ```jsonc
 * {
 *   "id":      "018f…",                      // uuid v7, also the Nats-Msg-Id dedupe key
 *   "at":      "2026-08-05T10:00:00.000Z",   // when it HAPPENED, never when it was ingested
 *   "orgId":   "…",                          // tenant; always equals the subject's org token
 *   "subject": "calls.evt.v1.…",             // self-describing: survives a replay to a file
 *   "type":    "channel.answered",           // unique WITHIN its family (the subject picks one)
 *   "source":  "engine",                     // publishing service
 *   "data":    { … }                         // per-type payload
 * }
 * ```
 *
 * ## Evolution / versioning policy
 *
 * - The subject carries the MAJOR version (`…​.v1.…`). A breaking payload change — removing a
 *   field, narrowing a type, changing a field's meaning — ships as a NEW subject version, and the
 *   two run side by side until every consumer moves. `packages/events` never breaks v1 in place.
 * - Within a major version, change is ADDITIVE ONLY: new optional fields, new event `type`s, new
 *   enum members. Producers may emit them at any time.
 * - Consumers are therefore built to tolerate the unknown. Payload schemas are `z.object` (zod's
 *   default strips unknown keys) rather than `z.strictObject`, so an old consumer validates a
 *   newer producer's event successfully and simply does not see the new field. `parseSubject`
 *   returns `event` as a plain string for the same reason.
 * - `cdr.leg.write` goes further and uses `z.looseObject`: unknown keys pass THROUGH to the CDR
 *   writer, which owns the column list.
 * - New required fields are a MAJOR change. There is no "minor version" field in the envelope on
 *   purpose — a version number consumers are expected to branch on is a migration that never
 *   finishes.
 */

/** Envelope MAJOR version. Mirrors the `v1` token in every subject. */
export const EVENT_ENVELOPE_MAJOR = 1;

/**
 * The publishing service's name: `engine`, `api`, `sipd`, `mediad`, `autopilot`, … Deliberately
 * a pattern and not an enum — a new service must not require an `events` release to publish.
 */
export const eventSourceSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9-]*$/, "source must be a kebab-case service name");

/** ISO-8601 instant in UTC (`Z`), millisecond precision. Offsets are rejected on purpose. */
export const eventInstantSchema = z.iso.datetime();

/** Every entity id on the wire is a UUID string (`packages/identifiers`). */
export const entityIdSchema = z.uuid();

/** The base envelope. Concrete events narrow `type` and `data` via {@link defineEvent}. */
export const baseEventEnvelopeSchema = z.object({
	/** UUID v7 — time-ordered, and the idempotency key consumers dedupe on. */
	id: z.uuidv7(),
	at: eventInstantSchema,
	orgId: entityIdSchema,
	subject: z.string().min(1),
	type: z.string().min(1),
	source: eventSourceSchema,
	/** W3C trace id when the event was produced inside a traced request. */
	traceId: z.string().min(1).max(128).optional(),
	/** Correlates a command with the events it caused (the ESL `Job-UUID` equivalent). */
	correlationId: z.string().min(1).max(128).optional(),
	data: z.unknown(),
});

export type BaseEventEnvelope = z.infer<typeof baseEventEnvelopeSchema>;

/** A typed event contract: its family, its `type` discriminator, its payload and its envelope. */
export interface EventDefinition<
	TFamily extends EventFamily,
	TType extends string,
	TData extends z.ZodType,
> {
	readonly family: TFamily;
	readonly type: TType;
	readonly data: TData;
	readonly envelope: z.ZodObject<{
		id: z.ZodUUID;
		at: z.ZodISODateTime;
		orgId: z.ZodUUID;
		subject: z.ZodString;
		type: z.ZodLiteral<TType>;
		source: z.ZodString;
		traceId: z.ZodOptional<z.ZodString>;
		correlationId: z.ZodOptional<z.ZodString>;
		data: TData;
	}>;
}

/** Declares one event type. The only way an envelope schema is built in this package. */
export function defineEvent<
	TFamily extends EventFamily,
	TType extends string,
	TData extends z.ZodType,
>(family: TFamily, type: TType, data: TData): EventDefinition<TFamily, TType, TData> {
	return {
		family,
		type,
		data,
		envelope: baseEventEnvelopeSchema.extend({ type: z.literal(type), data }),
	};
}

/** Any event definition, for helpers that do not care which family they were handed. */
// oxlint-disable-next-line no-explicit-any -- variance-free bound; each call site re-narrows.
export type AnyEventDefinition = EventDefinition<EventFamily, string, z.ZodType<any, any>>;

/** The envelope TS type produced by an {@link EventDefinition}. */
export type EventOf<TDefinition extends { readonly envelope: z.ZodType }> = z.infer<
	TDefinition["envelope"]
>;

/** The payload TS type produced by an {@link EventDefinition}. */
export type DataOf<TDefinition extends { readonly data: z.ZodType }> = z.infer<TDefinition["data"]>;

/** Everything a caller supplies; `id`, `at` and `type` are filled in when omitted. */
export interface EventInput<TData> {
	readonly orgId: string;
	readonly subject: string;
	readonly source: string;
	readonly data: TData;
	/** Defaults to a fresh UUID v7. Supply it to make a retry idempotent (see `publish.ts`). */
	readonly id?: string;
	/** Defaults to now. Supply the instant the thing HAPPENED whenever it is known. */
	readonly at?: string | Date;
	readonly traceId?: string;
	readonly correlationId?: string;
}

function toInstant(at: string | Date | undefined): string {
	if (at === undefined) {
		return new Date().toISOString();
	}
	return at instanceof Date ? at.toISOString() : at;
}

/**
 * Builds and validates one envelope. Throws {@link import("../errors").EventValidationError} on a
 * bad payload, so a malformed event never reaches the broker.
 */
export function makeEvent<TDefinition extends AnyEventDefinition>(
	definition: TDefinition,
	input: EventInput<DataOf<TDefinition>>,
): EventOf<TDefinition> {
	const candidate = {
		id: input.id ?? createEntityId(),
		at: toInstant(input.at),
		orgId: input.orgId,
		subject: input.subject,
		type: definition.type,
		source: input.source,
		...(input.traceId === undefined ? {} : { traceId: input.traceId }),
		...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
		data: input.data,
	};

	const result = definition.envelope.safeParse(candidate);
	if (!result.success) {
		throw validationErrorFrom(`Event ${definition.type}`, result.error, {
			subject: input.subject,
			eventType: definition.type,
		});
	}
	return result.data as EventOf<TDefinition>;
}
