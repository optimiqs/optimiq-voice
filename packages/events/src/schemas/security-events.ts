import { z } from "zod";
import { subjectFor, type SecurityEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";

/**
 * Security signals — `security.evt.v1.<orgId>.<subjectRef>.fraud-signal`.
 *
 * What the platform noticed on its own, as opposed to what somebody changed (`audit.evt.v1`) or
 * what a call did (`calls.evt.v1`). Two producers today, both in `apps/api`: the toll-fraud gate
 * refusing a dial at admission, and the anomaly detector's hourly pass over CDR.
 *
 * ## Why one event type and not one per finding
 *
 * The obvious shape is `fraud.minutes-spike`, `fraud.new-country`, `fraud.short-call-burst` — one
 * subject per thing that can be detected. It is the wrong shape here, because the consumer on the
 * other end is a webhook subscription and the thing a tenant subscribes to is "tell me about
 * fraud", not "tell me about the four heuristics this release happens to implement". Splitting the
 * type would mean every new detector is a change every subscriber must make to keep receiving
 * what they already asked for — which is how a subscription silently stops covering the case it
 * was created for.
 *
 * So the FINDING is data (`kind`), the type is stable, and a consumer that wants one heuristic
 * filters on a field instead of on a subject.
 *
 * ## `severity` exists so a consumer can page on it without knowing the kinds
 *
 * The kinds will grow; the three severities will not. An integration that routes `critical` to a
 * pager and `info` to a channel keeps working when a fifth detector lands, which is the whole
 * point of carrying a judgement alongside the evidence.
 */

/**
 * What was detected.
 *
 * **MUST equal `TOLL_FRAUD_SIGNAL_KINDS` in `packages/pbx-db/src/schema/toll-fraud-schema.ts`**,
 * plus the refusal kinds the admission gate raises, which have no column of their own. The contract
 * package cannot import the database package — the Go side consumes this schema and holds no
 * Drizzle — so the overlap is restated and this comment is the tie.
 *
 * The first four are the DETECTOR's, found by looking backwards over an hour of call records. The
 * last five are the GATE's, raised at the instant a dial was refused, and they are the same tokens
 * `TollFraudRefusalReason` uses in `apps/api/src/pbx/toll-fraud/toll-fraud.policy.ts` lowercased
 * into this family's kebab-case vocabulary — a refusal and a detection are both "the platform
 * noticed", and giving them two event types would make a tenant subscribe twice to learn one thing.
 */
export const SECURITY_SIGNAL_KINDS = [
	"international-minutes-spike",
	"high-risk-prefix",
	"short-call-burst",
	"registration-source-spread",
	"international-concurrency-exceeded",
	"international-minutes-exceeded",
	"destination-country-blocked",
	"new-country-hold",
	"off-hours-international-lock",
] as const;

export const securitySignalKindSchema = z.enum(SECURITY_SIGNAL_KINDS);
export type SecuritySignalKind = z.infer<typeof securitySignalKindSchema>;

/**
 * How much attention the finding deserves.
 *
 * Three values and no more: a consumer routes on this, and a scale finer than "tell me now / tell
 * me today / write it down" is a scale nobody can configure a rule against.
 */
export const SECURITY_SIGNAL_SEVERITIES = ["info", "warning", "critical"] as const;
export const securitySignalSeveritySchema = z.enum(SECURITY_SIGNAL_SEVERITIES);
export type SecuritySignalSeverity = z.infer<typeof securitySignalSeveritySchema>;

/** What the platform did about it on its own, if anything. */
export const SECURITY_SIGNAL_ACTIONS = ["none", "call-refused", "extension-suspended"] as const;
export const securitySignalActionSchema = z.enum(SECURITY_SIGNAL_ACTIONS);
export type SecuritySignalAction = z.infer<typeof securitySignalActionSchema>;

/** `fraud-signal` — the platform detected or refused something that looks like toll fraud. */
export const securityFraudSignalDataSchema = z.object({
	kind: securitySignalKindSchema,
	severity: securitySignalSeveritySchema,
	/**
	 * What the platform did. `none` is a detection that was only reported, which is the DEFAULT
	 * posture — see `toll_fraud_policy.auto_suspend_on_signal` for why an automatic suspension is
	 * opt-in.
	 */
	action: securitySignalActionSchema,
	/**
	 * The extension the signal is about, when there is one. Absent for a tenant-wide finding, whose
	 * subject carries `_org` in the same position.
	 */
	extensionId: z.uuid().optional(),
	/** The extension's dialable number, so an alert is readable without a second lookup. */
	extensionNumber: z.string().min(1).max(32).optional(),
	/**
	 * The destination that triggered it, in E.164. Present for a refusal, usually absent for a
	 * backward-looking detection that spans many destinations.
	 */
	destination: z.string().min(1).max(32).optional(),
	/** ISO-3166 alpha-2 of that destination, when it resolved to one. */
	destinationCountry: z.string().length(2).optional(),
	/**
	 * The number that crossed the line and the line it crossed — minutes against a minutes ceiling,
	 * calls against a call ceiling. Both absent for a finding with no threshold behind it (a first
	 * call to a new country is not a quantity).
	 *
	 * Deliberately unitless: the unit is implied by `kind`, and a `unit` field would be a string
	 * nobody switches on. `observed` without `threshold` is a detector reporting a magnitude it
	 * judged by shape rather than by a configured number.
	 */
	observed: z.number().min(0).optional(),
	threshold: z.number().min(0).optional(),
	/** The window the observation covers, in seconds, when it covers one. */
	windowSeconds: z.int().min(1).max(86_400).optional(),
	/** One sentence for a human, already assembled. Never a credential, never a full number list. */
	summary: z.string().min(1).max(512),
});

export const SECURITY_EVENT_DEFINITIONS = {
	"fraud-signal": defineEvent("security", "fraud-signal", securityFraudSignalDataSchema),
} as const;

export type SecurityEventDefinitions = typeof SECURITY_EVENT_DEFINITIONS;

export type SecurityEventOf<TType extends SecurityEvent> = z.infer<
	SecurityEventDefinitions[TType]["envelope"]
>;

export type SecurityEventDataOf<TType extends SecurityEvent> = z.infer<
	SecurityEventDefinitions[TType]["data"]
>;

export type SecurityFraudSignalData = z.infer<typeof securityFraudSignalDataSchema>;

/**
 * Every security event as one union.
 *
 * A single-member union today, shaped like `trunkEventSchema` on purpose: consumers parse against
 * the FAMILY schema, so a second signal joins the family without touching them.
 */
export const securityEventSchema = z.discriminatedUnion("type", [
	SECURITY_EVENT_DEFINITIONS["fraud-signal"].envelope,
]);

export type SecurityEventEnvelope = z.infer<typeof securityEventSchema>;

export interface SecurityEventInput<TType extends SecurityEvent> extends Omit<
	EventInput<SecurityEventDataOf<TType>>,
	"subject"
> {
	/** The extension id the signal is about, or `SECURITY_SCOPE_ORG` for a tenant-wide one. */
	readonly subjectRef: string;
}

/** Builds and validates a security event, deriving `security.evt.v1.<orgId>.<subjectRef>.<type>`. */
export function makeSecurityEvent<TType extends SecurityEvent>(
	type: TType,
	input: SecurityEventInput<TType>,
): SecurityEventOf<TType> {
	const definition = SECURITY_EVENT_DEFINITIONS[type];
	const subject = subjectFor.security(input.orgId, input.subjectRef, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as SecurityEventOf<TType>;
}
