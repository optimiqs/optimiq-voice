import { z } from "zod";
import { subjectFor } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";
import { macAddressSchema } from "./telephony";

/**
 * Device-provisioning events — `provision.evt.v1.<orgId>`.
 *
 * Unlike calls/registrations/queues, the event name is NOT a subject token: provisioning volume
 * is tiny and every consumer wants the whole org feed, so the subject stops at the org and the
 * discriminator lives in the envelope `type`. Filtering by type is a consumer-side concern.
 *
 * `device.rejected` is the security-relevant one. FusionPBX's provisioning endpoint was
 * unauthenticated (see `plans/reference/fusionpbx-inventory.md`); ours is MAC-token
 * authenticated, and every rejected attempt is published so anti-fraud can count them.
 */

export const PROVISION_EVENTS = ["device.requested", "device.rendered", "device.rejected"] as const;
export type ProvisionEvent = (typeof PROVISION_EVENTS)[number];

const provisionBase = {
	/** Where the request came from, `host:port`. Always known — it is the transport peer. */
	sourceAddress: z.string().max(64),
	/** Requested path, e.g. `/provision/y000000000044.cfg`. Recorded verbatim for forensics. */
	path: z.string().max(512).optional(),
	userAgent: z.string().max(256).optional(),
};

/** `device.requested` — a phone asked for its configuration. */
export const deviceRequestedDataSchema = z.object({
	...provisionBase,
	macAddress: macAddressSchema,
	/** Parsed from the User-Agent / path when recognisable. */
	vendor: z.string().max(64).optional(),
	model: z.string().max(64).optional(),
});

/** `device.rendered` — a config was produced and served. */
export const deviceRenderedDataSchema = z.object({
	...provisionBase,
	macAddress: macAddressSchema,
	vendor: z.string().max(64),
	model: z.string().max(64),
	/** `pbx-db` device row this config belongs to. */
	deviceId: z.uuid(),
	/** Template that produced it; the pair (template, profile) reproduces the exact output. */
	templateId: z.uuid(),
	deviceProfileId: z.uuid().optional(),
	bytes: z.int().min(0),
});

/** `device.rejected` — the request was refused. Feeds rate limiting and fail2ban-style blocking. */
export const deviceRejectedDataSchema = z.object({
	...provisionBase,
	/** Absent when the request carried no parsable MAC at all. */
	macAddress: macAddressSchema.optional(),
	reason: z.enum([
		"unknown-mac",
		"invalid-token",
		"missing-token",
		"unknown-vendor",
		"template-missing",
		"rate-limited",
		"disabled",
		/**
		 * The token verified, but the request came from an address the organization's provisioning
		 * ACL refuses.
		 *
		 * Its own reason rather than being folded into `disabled`, because the two mean opposite
		 * things to whoever is counting them: `disabled` is an administrator's own configuration
		 * doing what it was told, while this one is a VALID credential being presented from an
		 * unexpected network — which is what a stolen provisioning URL looks like from the outside,
		 * and is the single most actionable signal this event family carries.
		 */
		"ip-not-allowed",
		/**
		 * The deployment cannot render configurations at all yet (no SIP server or no secret root
		 * key). Not the device's fault and not an attack; separated so an operator's missing
		 * variable is not counted as a rejection in the anti-fraud view.
		 */
		"not-configured",
	]),
	detail: z.string().max(512).optional(),
});

export const PROVISION_EVENT_DEFINITIONS = {
	"device.requested": defineEvent("provision", "device.requested", deviceRequestedDataSchema),
	"device.rendered": defineEvent("provision", "device.rendered", deviceRenderedDataSchema),
	"device.rejected": defineEvent("provision", "device.rejected", deviceRejectedDataSchema),
} as const;

export type ProvisionEventDefinitions = typeof PROVISION_EVENT_DEFINITIONS;

export type ProvisionEventOf<TType extends ProvisionEvent> = z.infer<
	ProvisionEventDefinitions[TType]["envelope"]
>;

export type ProvisionEventDataOf<TType extends ProvisionEvent> = z.infer<
	ProvisionEventDefinitions[TType]["data"]
>;

export const provisionEventSchema = z.discriminatedUnion("type", [
	PROVISION_EVENT_DEFINITIONS["device.requested"].envelope,
	PROVISION_EVENT_DEFINITIONS["device.rendered"].envelope,
	PROVISION_EVENT_DEFINITIONS["device.rejected"].envelope,
]);

export type ProvisionEventEnvelope = z.infer<typeof provisionEventSchema>;

export type ProvisionEventInput<TType extends ProvisionEvent> = Omit<
	EventInput<ProvisionEventDataOf<TType>>,
	"subject"
>;

/** Builds and validates a provisioning event, deriving `provision.evt.v1.<orgId>`. */
export function makeProvisionEvent<TType extends ProvisionEvent>(
	type: TType,
	input: ProvisionEventInput<TType>,
): ProvisionEventOf<TType> {
	const definition = PROVISION_EVENT_DEFINITIONS[type];
	const subject = subjectFor.provision(input.orgId);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as ProvisionEventOf<TType>;
}
