import { z } from "zod/v4";
import { SIP_TRANSPORTS, TRUNK_KINDS } from "@optimiq-voice/pbx-db";
import { displayName, patchOf } from "../shared/dto";

/**
 * `status`, `statusChangedAt`, `statusReason` and `statusLatencyMs` are deliberately absent: they
 * are the engine's view of the carrier, and a control-plane form that could set them would let an
 * admin declare a dead trunk healthy.
 */
export const createTrunkDto = z.strictObject({
	name: displayName,
	kind: z.enum(TRUNK_KINDS).optional(),
	sipDomain: z.string().min(1).max(255),
	sipProxy: z.string().min(1).max(255),
	outboundProxy: z.string().max(255).nullish(),
	authUser: z.string().max(128).nullish(),
	/** Handle into the secret manager; the password never lands in this database. */
	sipSecretRef: z.string().max(256).nullish(),
	registerExpiresSeconds: z.int().min(30).max(86_400).optional(),
	transport: z.enum(SIP_TRANSPORTS).optional(),
	codecPrefs: z.string().max(128).nullish(),
	maxChannels: z.int().min(1).max(10_000).nullish(),
	callerIdNumberOverride: z.string().max(32).nullish(),
	enabled: z.boolean().optional(),
});

export const updateTrunkDto = patchOf(createTrunkDto);
