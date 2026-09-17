/**
 * Whether a live leg's audio is actually encrypted, and how to say so.
 *
 * ## Why this is a flag and not a setting
 *
 * `packages/telephony`'s `encrypted` channel flag is written by the engine from the SRTP context
 * `mediad` INSTALLED — not from the organization's policy and not from the transport the phone
 * signalled over. That distinction is the entire value of the indicator: a tenant who has asked for
 * SRTP and is not getting it is exactly the person who needs to be told, and an icon derived from
 * the setting would tell them what they already asked for instead of what is happening.
 *
 * ## Absent means "no", and a renderer must not say "no" too early
 *
 * The flag is absent both on a leg negotiated in the clear and on a leg that has negotiated nothing
 * yet, so {@link isLegEncrypted} answers `false` for both and the CALLER decides whether the
 * question is ripe. The softphone asks only while a call is connected; the summary counts only legs
 * the feed already holds. Neither draws an open padlock over a call that is still ringing.
 */

/** Mirrors the `encrypted` member of `CHANNEL_FLAGS` in `@optimiq-voice/telephony`. */
export const ENCRYPTED_FLAG = "encrypted";

/** One leg of the live feed, narrowed to what this decision reads. Structural on purpose. */
export interface EncryptableLeg {
	readonly flags?: readonly string[];
}

export function isLegEncrypted(leg: EncryptableLeg | undefined): boolean {
	return leg?.flags?.includes(ENCRYPTED_FLAG) === true;
}

/**
 * How many of these legs are carrying encrypted audio, and how many there are.
 *
 * Legs and not calls, deliberately, and the difference is the point: a bridged call is two legs and
 * they can disagree — a TLS handset on SRTP talking to a carrier on plain RTP is one encrypted leg
 * and one that is not. Counting calls would have to pick one of those two answers, and both would
 * be wrong half the time.
 */
export function encryptedLegCount(legs: Iterable<EncryptableLeg>): {
	readonly encrypted: number;
	readonly total: number;
} {
	let encrypted = 0;
	let total = 0;
	for (const leg of legs) {
		total += 1;
		if (isLegEncrypted(leg)) {
			encrypted += 1;
		}
	}
	return { encrypted, total };
}

/**
 * The tooltip, in words rather than a colour.
 *
 * "Media encrypted" and not "Secure": encryption of the audio says nothing about who is on the
 * other end, and a padlock that reads as "safe" is the claim this label deliberately does not make.
 */
export function encryptionLabel(encrypted: boolean): string {
	return encrypted
		? "Media encrypted (SRTP)"
		: "Media not encrypted — this call's audio is carried as plain RTP";
}
