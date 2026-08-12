import { z } from "zod/v4";

/**
 * The moderation request bodies.
 *
 * Five of the seven actions take nothing at all: the ACTION is in the path and the PARTICIPANT is in
 * the path, so there is nothing left for a body to say. `volume` is the exception, because a level
 * is a value rather than a verb.
 *
 * `strictObject` for the reason every other DTO here uses it: a typo'd key is a value the caller
 * believes they sent and the server silently dropped — and on this surface the dropped value would
 * be the difference between muting somebody and doing nothing.
 */

/**
 * Mute, unmute, deafen, undeafen, kick and lock take an empty body.
 *
 * Declared rather than skipped so `POST …/mute {"direction":"out"}` is a 400 rather than a request
 * that looks like it chose something. There is deliberately no direction field: muting somebody and
 * deafening them are different acts with different consequences, and a moderation UI that offered
 * one control with a direction dropdown would be describing a mixer rather than a meeting.
 */
export const emptyConferenceModerationDto = z.strictObject({});

/**
 * A participant's level, in PERCENT of unity.
 *
 * Percent rather than decibels because the only caller is a slider and a dB scale needs a curve at
 * both ends to be usable; percent rather than the mixer's Q8 fixed point because that is an
 * implementation's unit. 100 is unchanged, 0 is silent, and the ceiling is 400 because a member
 * amplified past four times unity is clipping rather than louder.
 *
 * `scope` says WHICH half: `talk` is their contribution to the room, `listen` is what they hear of
 * it. Both, when omitted — which is what a single slider means.
 */
export const setConferenceVolumeDto = z.strictObject({
	gainPercent: z.number().int().min(0).max(400),
	scope: z.enum(["talk", "listen", "both"]).optional(),
});
