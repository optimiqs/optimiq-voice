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

export const PROVISION_EVENTS = [
	"device.requested",
	"device.rendered",
	"device.rejected",
	"credential.invalidated",
] as const;
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

/**
 * `credential.invalidated` — the SIP credentials this organization's phones hold have changed.
 *
 * ## The channel that did not exist
 *
 * `apps/sipd` caches the answer to `rpc.sip.v1.credential` for 30 s and, until this event, had no
 * way to learn that one had become wrong: the RPC is pull-only with no paired push subject, a
 * `sipSecretRef` rotation does not move the routing snapshot hash, and the `trunks` bucket carries
 * a secret reference only for CARRIER trunks. The measured consequence was a phone knocked offline
 * for up to the whole TTL after a rotation, and the edge's only compensation was re-asking once
 * after a failed digest. `apps/api` holds the same answer in its own cache
 * (`pbx/sip-credentials/sip-credentials.cache.ts`) and evicts it on the commit; this is that
 * eviction, said out loud, so the second cache can follow the first.
 *
 * ## Why it is in THIS family
 *
 * The provisioning family is the one whose subject stops at the organization and puts the
 * discriminator in the envelope `type`, "because provisioning volume is tiny and every consumer
 * wants the whole org feed" — which is this event exactly: it fires when an administrator clicks
 * save, and its only consumer wants all of them for the tenant. It is also the family that OWNS
 * the password in question: `provision.service.ts` derives what a phone is given, and the
 * credential responder repeats that derivation. A root of its own would have bought a narrower
 * grant and cost a fourth stream, a fourth family and a fourth consumer.
 *
 * ## Whole-organization, and no account list
 *
 * The API's mutation seam reports a TABLE and a tenant, not a row identity — and a
 * `device_line.auth_user` edit invalidates the entry under the OLD username, which the new row does
 * not know. So the honest event says "everything you hold for this tenant is suspect", and a
 * consumer that keys its cache by `(realm, username)` with one realm per deployment drops the lot.
 * It carries no username, no realm and no digest: a subscriber learns that something changed, never
 * what it changed to.
 */
export const credentialInvalidatedDataSchema = z.object({
	/**
	 * What moved, as `"<operation> on <table>"` — e.g. `update on extension`. A human string for a
	 * log line and nothing a consumer should branch on; the event means the same thing whatever it
	 * says, and a consumer that parsed it would break the first time a table was renamed.
	 */
	reason: z.string().max(128),
	/** How many entries the API dropped from its own cache. Diagnostics; may legitimately be 0. */
	dropped: z.int().min(0),
});

export const PROVISION_EVENT_DEFINITIONS = {
	"device.requested": defineEvent("provision", "device.requested", deviceRequestedDataSchema),
	"device.rendered": defineEvent("provision", "device.rendered", deviceRenderedDataSchema),
	"device.rejected": defineEvent("provision", "device.rejected", deviceRejectedDataSchema),
	"credential.invalidated": defineEvent(
		"provision",
		"credential.invalidated",
		credentialInvalidatedDataSchema,
	),
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
	PROVISION_EVENT_DEFINITIONS["credential.invalidated"].envelope,
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
