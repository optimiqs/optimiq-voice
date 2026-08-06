import { z } from "zod/v4";
import { displayName, internalNumber, patchOf, resettable } from "../shared/dto";
import { voicemailPinIssue } from "../voicemail-boxes/voicemail-boxes.dto";

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

// ---------------------------------------------------------------------------------------------
// The PINs
// ---------------------------------------------------------------------------------------------

/**
 * `POST /conferences/:id/pin` and `POST /conferences/:id/moderator-pin`.
 *
 * The policy is the mailbox's, imported rather than restated: `voicemailPinIssue` is the single
 * definition of what a telephone-keypad PIN may be in this platform — digits only, four to ten of
 * them, no single repeated digit, no straight run. Copying those four rules here would produce two
 * policies that agree today and drift the first time either is tightened, and the argument for each
 * rule (a DTMF keypad has ten keys; `#` terminates entry; three attempts per call make the
 * first-guessed shapes materially weaker) applies identically to a room.
 *
 * The name of the imported function still says "voicemail". That is left alone deliberately — see
 * `conference-pin.service.ts` — because the alternative is a rename that touches three verify
 * scripts to improve nothing.
 *
 * The plaintext PIN travels in the BODY and nowhere else, never a query parameter, which is the
 * part of a URL that proxies and access logs record by default. It is hashed before the request
 * returns and is never stored, never logged and never echoed back.
 */
export const setConferencePinDto = z.strictObject({
	pin: z.string().superRefine((value, context) => {
		const issue = voicemailPinIssue(value);
		if (issue !== undefined) {
			context.addIssue({ code: "custom", message: issue });
		}
	}),
});
