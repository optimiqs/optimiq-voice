import { z } from "zod/v4";
import { RECORD_POLICIES } from "@optimiq-voice/pbx-db";
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
	/**
	 * How much of the room is captured — the same vocabulary `extension`, `trunk` and `queue` carry,
	 * which replaced a `recordEnabled` boolean the engine read by nothing.
	 *
	 * `inbound` and `outbound` are accepted and behave as `all` here: every leg in a conference is
	 * inbound TO the room, so there is no outbound half to leave out. They are not refused because
	 * the vocabulary is SHARED, and a DTO that allowed three of five values would be a second,
	 * narrower vocabulary wearing the same name.
	 */
	recordPolicy: z.enum(RECORD_POLICIES).optional(),
	mohClassId: z.uuid().nullish(),
	/**
	 * Play each arrival's and departure's name to the room.
	 *
	 * Distinct from the two tone flags below, which is a distinction a tenant can feel: a name
	 * announcement costs everybody in the meeting three seconds of somebody's voice, and a beep costs
	 * a quarter of a second. A large room usually wants the second and not the first.
	 */
	announceJoinLeave: z.boolean().optional(),
	/**
	 * Beep the room on a join and on a leave. Both default ON in the database, and the default is a
	 * privacy position rather than a taste: a participant who cannot tell a third party has arrived
	 * does not know the conversation stopped being private.
	 */
	entryToneEnabled: z.boolean().optional(),
	exitToneEnabled: z.boolean().optional(),
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
