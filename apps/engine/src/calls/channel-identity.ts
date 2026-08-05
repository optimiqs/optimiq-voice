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

/** The channel variables the engine reads off a channel at `StasisStart`. */
export const ENGINE_CHANNEL_VARIABLES = [
	"OPTIMIQ_ORG_ID",
	"OPTIMIQ_CALL_DIRECTION",
	"OPTIMIQ_ROUTING_CONTEXT",
] as const;

export type EngineChannelVariable = (typeof ENGINE_CHANNEL_VARIABLES)[number];

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
