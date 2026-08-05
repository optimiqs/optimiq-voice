import { z } from "zod";
import { aorSubjectToken, subjectFor, type RegistrationEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";
import { sipTransportSchema } from "./telephony";

/**
 * SIP registrar events — `sip.reg.v1.<orgId>.<aorHash>.<event>`.
 *
 * The subject token is a hash of the AOR (see `aorSubjectToken`), so the readable `aor` always
 * travels in the payload. The authoritative "who is registered right now" answer is the
 * `registrations` KV bucket; this stream is the transition log behind it — what feeds presence,
 * fail2ban-style anti-fraud counting and the admin "registrations" view.
 */

/** An Address of Record, e.g. `sip:1001@acme.example.com` or `1001@acme.example.com`. */
export const aorSchema = z.string().min(3).max(256);

/** A SIP contact URI as the device offered it, including any `;transport=` parameters. */
export const contactSchema = z.string().min(3).max(512);

const registrationBase = {
	aor: aorSchema,
	/** Always equals the subject's token; carried so a replayed file is self-describing. */
	aorHash: z.string().regex(/^[0-9a-f]{32}$/),
	contact: contactSchema,
	transport: sipTransportSchema,
	userAgent: z.string().max(256).optional(),
	/** Signalling source, `host:port`, after NAT rewriting. */
	sourceAddress: z.string().max(64).optional(),
	/** The `pbx-db` device this contact belongs to, when the registrar could resolve one. */
	deviceId: z.uuid().optional(),
	extensionId: z.uuid().optional(),
};

/** `registered` — a REGISTER was accepted (new binding or refresh). */
export const registrationRegisteredDataSchema = z.object({
	...registrationBase,
	/** `Expires` granted by the registrar, in seconds. */
	expiresInSeconds: z.int().min(1).max(86_400),
	/** True when this refreshed an existing binding rather than creating one. */
	refreshed: z.boolean().optional(),
});

/** `unregistered` — the device explicitly deregistered (`Expires: 0`) or was evicted. */
export const registrationUnregisteredDataSchema = z.object({
	...registrationBase,
	reason: z.enum(["client", "admin", "replaced", "gateway-down"]).optional(),
});

/** `expired` — the registrar's TTL sweep removed a binding nobody refreshed. */
export const registrationExpiredDataSchema = z.object({
	...registrationBase,
	/** How long the binding had been in place, in seconds. */
	registeredForSeconds: z.int().min(0).optional(),
});

export const REGISTRATION_EVENT_DEFINITIONS = {
	registered: defineEvent("registration", "registered", registrationRegisteredDataSchema),
	unregistered: defineEvent("registration", "unregistered", registrationUnregisteredDataSchema),
	expired: defineEvent("registration", "expired", registrationExpiredDataSchema),
} as const;

export type RegistrationEventDefinitions = typeof REGISTRATION_EVENT_DEFINITIONS;

export type RegistrationEventOf<TType extends RegistrationEvent> = z.infer<
	RegistrationEventDefinitions[TType]["envelope"]
>;

export type RegistrationEventDataOf<TType extends RegistrationEvent> = z.infer<
	RegistrationEventDefinitions[TType]["data"]
>;

/** Every registration event as one discriminated union. */
export const registrationEventSchema = z.discriminatedUnion("type", [
	REGISTRATION_EVENT_DEFINITIONS.registered.envelope,
	REGISTRATION_EVENT_DEFINITIONS.unregistered.envelope,
	REGISTRATION_EVENT_DEFINITIONS.expired.envelope,
]);

export type RegistrationEventEnvelope = z.infer<typeof registrationEventSchema>;

/**
 * Input for {@link makeRegistrationEvent}. The AOR hash is derived from `data.aor`, so a caller
 * cannot publish a payload whose AOR disagrees with its subject.
 */
export type RegistrationEventInput<TType extends RegistrationEvent> = Omit<
	EventInput<RegistrationEventDataOf<TType>>,
	"subject"
>;

/** Builds and validates a registration event, deriving both the subject and `data.aorHash`. */
export function makeRegistrationEvent<TType extends RegistrationEvent>(
	type: TType,
	input: RegistrationEventInput<TType>,
): RegistrationEventOf<TType> {
	const definition = REGISTRATION_EVENT_DEFINITIONS[type];
	const aorHash = aorSubjectToken(input.data.aor);
	const subject = subjectFor.registration(input.orgId, aorHash, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, {
		...input,
		subject,
		data: { ...input.data, aorHash },
	} as never) as RegistrationEventOf<TType>;
}
