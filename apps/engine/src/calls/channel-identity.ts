import { createDeterministicEntityId, isEntityId } from "@optimiq-voice/identifiers";

/**
 * The ARI ↔ domain identifier bridge.
 *
 * ## The problem
 *
 * ARI names channels `1754400000.42` and Local channels `1754400000.42;1`. The event contract in
 * `@optimiq-voice/events` requires every `legId` and `callId` to be a UUID, because those ids are
 * foreign keys in `cdr-db` and tokens in NATS subjects. Something has to bridge the two.
 *
 * ## The choice
 *
 * A DETERMINISTIC id derived from the ARI channel id (UUID v3 over a frozen namespace, from
 * `@optimiq-voice/identifiers`), not a random one held in a map.
 *
 * That matters for exactly one reason, and it is the reason the engine exists: an engine instance
 * can die mid-call. When another instance picks the channel up from the `channels` KV bucket — or
 * when the same instance restarts and re-reads live channels from ARI — it must arrive at the SAME
 * `legId`, or the CDR gets written twice under two ids and the call appears twice on the bill. A
 * random id in a lost `Map` cannot do that; a pure function of the ARI id always can.
 *
 * The `cdr.leg.write` record id is the exception: it is a UUID **v7** minted at write time
 * (`createEntityId`), because it is the insert's idempotency key and must be time-ordered.
 */

/**
 * Namespace prefixes. Frozen: changing one re-keys every leg and call id in flight and breaks
 * correlation with rows already written.
 */
const LEG_NAMESPACE = "optimiq-voice:ari-channel";
const CALL_NAMESPACE = "optimiq-voice:ari-call";

/** The domain leg id for an ARI channel. Stable for the lifetime of that channel, and beyond. */
export function legIdForAriChannel(ariChannelId: string): string {
	assertNonEmpty("ariChannelId", ariChannelId);
	return createDeterministicEntityId(`${LEG_NAMESPACE}:${ariChannelId}`);
}

/**
 * The domain call id for a call rooted at an ARI channel.
 *
 * Derived from the ROOT channel — the A-leg — so every leg the engine originates for that call
 * lands on the same `calls.evt.v1.<org>.<callId>.*` subject and therefore in the same JetStream
 * per-subject ordering group.
 */
export function callIdForAriChannel(rootAriChannelId: string): string {
	assertNonEmpty("rootAriChannelId", rootAriChannelId);
	return createDeterministicEntityId(`${CALL_NAMESPACE}:${rootAriChannelId}`);
}

/**
 * The organization a channel belongs to, from its channel variables.
 *
 * Returns `undefined` when the value is absent or is not a valid entity id. The caller MUST treat
 * that as a rejection rather than a default: filing a call under the wrong tenant is a billing
 * error and an isolation breach, and the failure mode of guessing is silent.
 */
export function resolveOrganizationId(
	variables: Readonly<Record<string, string | undefined>>,
	fallback?: string,
): string | undefined {
	const candidate = firstNonEmpty([variables.OPTIMIQ_ORG_ID, variables.OPTIMIQ_ORGANIZATION_ID]);
	if (candidate !== undefined && isEntityId(candidate)) {
		return candidate;
	}
	if (fallback !== undefined && isEntityId(fallback)) {
		return fallback;
	}
	return undefined;
}

/**
 * Where the SIP `Call-ID` of a leg's dialog is kept, once the engine has read it.
 *
 * A channel VARIABLE rather than a field on `CallerProfile` or `ChannelSnapshot`, and the choice is
 * the same one `OPTIMIQ_BRIDGE_PEER_LEG_ID` makes for the same reason: variables are already
 * mirrored into the `channels` KV bucket, so an instance that picks this leg up after a failover
 * reads the same Call-ID and can answer a REFER about it. A field would live only in the process
 * that died — and would put a signalling concept into `@optimiq-voice/telephony`, which is the one
 * package that must stay free of them.
 */
export const SIP_CALL_ID_VARIABLE = "OPTIMIQ_SIP_CALL_ID";

/**
 * What the engine asks the media server for when nothing has stamped {@link SIP_CALL_ID_VARIABLE}.
 *
 * `CHANNEL(pjsip,call-id)` and not `PJSIP_HEADER(read,Call-ID)`. Both name the same string, but the
 * header function only reads the request that CREATED the channel and Asterisk restricts it to a
 * pre-dial handler on an outgoing leg — which is exactly the leg a desk phone that ANSWERED a call
 * is sitting on, so half of all transfers would find nothing. The `CHANNEL()` key is answered from
 * the PJSIP session itself, is readable over `GET /channels/{id}/variable` at any point in the
 * channel's life, and is the same value in both directions.
 *
 * A non-PJSIP channel (a Local half, an ARI-originated `Snoop`) answers empty, which is correct:
 * those legs have no SIP dialog and nothing can REFER about them.
 */
export const SIP_CALL_ID_CHANNEL_FUNCTION = "CHANNEL(pjsip,call-id)";

/**
 * The channel variables the engine reads off a channel at `StasisStart`.
 *
 * The last one is not read by its own name — see {@link SIP_CALL_ID_CHANNEL_FUNCTION} — but it is
 * stored under it, which is what makes it a variable rather than a lookup.
 */
export const ENGINE_CHANNEL_VARIABLES = [
	"OPTIMIQ_ORG_ID",
	"OPTIMIQ_CALL_DIRECTION",
	"OPTIMIQ_ROUTING_CONTEXT",
	/** `b` on a leg the engine originated; absent on a leg that arrived from the outside. */
	"OPTIMIQ_LEG",
	SIP_CALL_ID_VARIABLE,
] as const;

export type EngineChannelVariable = (typeof ENGINE_CHANNEL_VARIABLES)[number];

/**
 * The Call-ID as an index key, or `undefined` when there is nothing worth indexing.
 *
 * Trimmed, because a dialplan `Set()` and a media server that pads its answer both happen. Rejected
 * above 256 characters rather than truncated: that is the ceiling
 * `sipTransferRequestSchema.sipCallId` enforces, so a longer value could never be matched by a
 * request anyway, and a truncated key would match the WRONG call rather than none.
 *
 * Compared byte-for-byte thereafter. RFC 3261 §20.8 makes the `Call-ID` case-SENSITIVE, and it is
 * an opaque token both ends echo verbatim, so folding case here would be inventing an equivalence
 * the protocol does not have.
 */
export function normalizeSipCallId(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed === "" || trimmed.length > 256) {
		return undefined;
	}
	return trimmed;
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed !== undefined && trimmed !== "") {
			return trimmed;
		}
	}
	return undefined;
}

function assertNonEmpty(role: string, value: string): void {
	if (value.trim() === "") {
		throw new TypeError(`${role} must not be empty`);
	}
}
