import { z } from "zod/v4";
import { displayName, internalNumber, patchOf, resettable } from "../shared/dto";

/**
 * A conference room.
 *
 * `pinHash` / `moderatorPinHash` are deliberately not settable here — see
 * `conferences.resource.ts`. `waitForModerator` is accepted regardless: a room with no moderator
 * PIN and `waitForModerator` on holds everyone in music-on-hold forever, which is a configuration
 * the compiler is free to warn about and this layer has no business guessing at.
 */
export const createConferenceDto = z.strictObject({
	name: displayName,
	/** The number dialed to enter the room. Unique per organization. */
	roomNumber: internalNumber,
	maxMembers: resettable(z.int().min(2).max(1000)),
	recordEnabled: z.boolean().optional(),
	mohClassId: z.uuid().nullish(),
	announceJoinLeave: z.boolean().optional(),
	/** Hold participants in music-on-hold until a moderator PIN is entered. */
	waitForModerator: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const updateConferenceDto = patchOf(createConferenceDto);
