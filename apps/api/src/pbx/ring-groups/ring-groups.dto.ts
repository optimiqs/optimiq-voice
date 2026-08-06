import { z } from "zod/v4";
import { RING_GROUP_STRATEGIES } from "@optimiq-voice/pbx-db";
import {
	destinationShape,
	displayName,
	internalNumber,
	namedDestinationShape,
	patchOf,
	resettable,
} from "../shared/dto";

export const createRingGroupDto = z.strictObject({
	name: displayName,
	extensionNumber: internalNumber.nullish(),
	strategy: z.enum(RING_GROUP_STRATEGIES).optional(),
	ringTimeoutSeconds: resettable(z.int().min(5).max(600)),
	callerIdNamePrefix: z.string().max(32).nullish(),
	/** Skip members already on a call instead of offering them the leg. */
	ignoreBusy: z.boolean().optional(),
	confirmEnabled: z.boolean().optional(),
	confirmPromptId: z.uuid().nullish(),
	mohClassId: z.uuid().nullish(),
	ringbackPromptId: z.uuid().nullish(),
	...namedDestinationShape("timeout"),
	enabled: z.boolean().optional(),
});

export const updateRingGroupDto = patchOf(createRingGroupDto);

export const createRingGroupDestinationDto = z.strictObject({
	ordinal: z.int().min(0).max(1000),
	...destinationShape(true),
	/** Always 0 for `simultaneous`; the delay is what makes `sequential` sequential. */
	delaySeconds: resettable(z.int().min(0).max(300)),
	timeoutSeconds: resettable(z.int().min(1).max(600)),
	confirmRequired: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const updateRingGroupDestinationDto = patchOf(createRingGroupDestinationDto);
