import { CLAIM_LEASE_MS } from "../routing/claim-timing";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/** Persisted on every channel snapshot so another engine replica can fence or adopt it. */
export const CHANNEL_OWNER_INSTANCE_VARIABLE = "OPTIMIQ_ENGINE_INSTANCE_ID";
export const CHANNEL_OWNER_EXPIRES_AT_VARIABLE = "OPTIMIQ_ENGINE_OWNER_EXPIRES_AT";

/** Shared with the other engine claims: three default heartbeat attempts fit inside one lease. */
export const CHANNEL_OWNERSHIP_LEASE_MS = CLAIM_LEASE_MS;

export interface ChannelOwnership {
	readonly instanceId: string;
	readonly expiresAt: number;
}

/** Reads a valid ownership lease, or `undefined` for a legacy/unowned snapshot. */
export function channelOwnershipOf(snapshot: ChannelSnapshot): ChannelOwnership | undefined {
	const instanceId = snapshot.variables[CHANNEL_OWNER_INSTANCE_VARIABLE]?.trim();
	const expiresAt = Number(snapshot.variables[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]);
	if (instanceId === undefined || instanceId === "" || !Number.isFinite(expiresAt)) {
		return undefined;
	}
	return { instanceId, expiresAt };
}

/** Returns the wire snapshot for one lease without mutating the aggregate's local snapshot. */
export function withChannelOwnership(
	snapshot: ChannelSnapshot,
	instanceId: string,
	expiresAt: number,
): ChannelSnapshot {
	return {
		...snapshot,
		variables: {
			...snapshot.variables,
			[CHANNEL_OWNER_INSTANCE_VARIABLE]: instanceId,
			[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]: String(expiresAt),
		},
	};
}
