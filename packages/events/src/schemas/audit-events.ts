import { z } from "zod";
import { subjectFor } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";

/**
 * Audit events — `audit.evt.v1.<orgId>`.
 *
 * One message per control-plane decision worth remembering: who did what to which resource, and
 * whether it was allowed. Append-only by construction (the `AUDIT` stream refuses writes rather
 * than discarding old ones) and mirrored into an append-only Postgres table by a durable
 * consumer, matching the RLS append-only policy pattern in `plans/…/oikos-conventions.md` §5.
 *
 * Denied and failed attempts are audited too — an audit trail that only records successes cannot
 * answer the question it exists for.
 */

/** Who acted. `system` covers schedulers, retention sweeps and migrations. */
export const auditActorSchema = z.object({
	type: z.enum(["user", "api-key", "service", "system"]),
	/** better-auth user id, API key id, or service name. Absent for `system`. */
	id: z.string().max(128).optional(),
	/** Display label at the time of the action — resolving it later may be impossible. */
	label: z.string().max(256).optional(),
	ip: z.string().max(64).optional(),
	userAgent: z.string().max(512).optional(),
});

/** What was acted on. `type` is the resource half of the permission string (`extension`, …). */
export const auditResourceSchema = z.object({
	type: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z][a-z0-9-]*$/, "resource type must be kebab-case"),
	id: z.string().max(128).optional(),
	label: z.string().max(256).optional(),
});

/**
 * Field-level diff. Values are `unknown` on purpose: the audit consumer stores them as JSONB and
 * never interprets them, and the producer is responsible for redacting secrets BEFORE publishing
 * (`packages/logging` redaction rules apply — never put a credential in `changes`).
 */
export const auditChangeSchema = z.object({
	from: z.unknown().optional(),
	to: z.unknown().optional(),
});

export const auditRecordedDataSchema = z.object({
	actor: auditActorSchema,
	/** `<resource>.<action>` — the same vocabulary as the permission registry. */
	action: z
		.string()
		.min(1)
		.max(96)
		.regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "action must be dotted kebab-case"),
	resource: auditResourceSchema,
	outcome: z.enum(["allowed", "denied", "failed"]),
	/** Correlation id of the HTTP request that caused this. */
	requestId: z.string().max(128).optional(),
	changes: z.record(z.string(), auditChangeSchema).optional(),
	/** Why it was denied or how it failed. */
	reason: z.string().max(512).optional(),
});

export const AUDIT_RECORDED = defineEvent("audit", "audit.recorded", auditRecordedDataSchema);

export const AUDIT_EVENT_DEFINITIONS = {
	"audit.recorded": AUDIT_RECORDED,
} as const;

export type AuditRecordedData = z.infer<typeof auditRecordedDataSchema>;

export const auditEventSchema = z.discriminatedUnion("type", [AUDIT_RECORDED.envelope]);

export type AuditEventEnvelope = z.infer<typeof auditEventSchema>;
export type AuditRecordedEnvelope = z.infer<typeof AUDIT_RECORDED.envelope>;

/** Builds and validates an audit event, deriving `audit.evt.v1.<orgId>`. */
export function makeAuditEvent(
	input: Omit<EventInput<AuditRecordedData>, "subject">,
): AuditRecordedEnvelope {
	return makeEvent(AUDIT_RECORDED, { ...input, subject: subjectFor.audit(input.orgId) });
}
