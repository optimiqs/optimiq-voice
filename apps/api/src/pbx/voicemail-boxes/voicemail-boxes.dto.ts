import { z } from "zod/v4";
import { VOICEMAIL_EMAIL_MODES } from "@optimiq-voice/pbx-db";
import { internalNumber, patchOf, resettable } from "../shared/dto";

export const createVoicemailBoxDto = z.strictObject({
	/** Usually the extension number, but boxes may be standalone. */
	mailboxNumber: internalNumber,
	label: z.string().max(128).nullish(),
	extensionId: z.uuid().nullish(),
	emailAddress: z.email().max(255).nullish(),
	emailMode: z.enum(VOICEMAIL_EMAIL_MODES).optional(),
	/** Classic "email and delete": the box keeps no copy. */
	deleteAfterDelivery: z.boolean().optional(),
	transcriptionEnabled: z.boolean().optional(),
	mwiEnabled: z.boolean().optional(),
	maxMessages: resettable(z.int().min(1).max(10_000)),
	maxMessageSeconds: resettable(z.int().min(10).max(3600)),
	enabled: z.boolean().optional(),
});

export const updateVoicemailBoxDto = patchOf(createVoicemailBoxDto);

// ---------------------------------------------------------------------------------------------
// The PIN
// ---------------------------------------------------------------------------------------------

/**
 * The PIN policy.
 *
 * Digits only, because the only keypad this secret is ever entered on is a telephone's: a policy
 * that admits characters a caller cannot type produces mailboxes nobody can open. Four as the
 * floor because it is what every PBX has trained users to expect, and because the control that
 * actually bounds online guessing is the engine's three-attempt limit
 * (`ENGINE_VOICEMAIL_PIN_ATTEMPTS`) rather than the length. Ten as the ceiling because DTMF entry
 * is terminated by `#` and a longer secret is mistyped far more often than it is guessed.
 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 10;

const DIGITS_ONLY = /^\d+$/u;

/**
 * Why a string is not an acceptable PIN, or `undefined` when it is one.
 *
 * The two refused SHAPES exist because of the attempt limit, not because of entropy: with three
 * tries per call, a PIN drawn from the handful of sequences an attacker tries first is materially
 * weaker than one that is not. The blocklist stops there deliberately. A longer one — birthdays,
 * `1122`, keypad patterns — starts guessing at what a user meant and produces "rejected, and I do
 * not know why", which is how PINs end up written on the handset.
 */
export function voicemailPinIssue(pin: string): string | undefined {
	if (!DIGITS_ONLY.test(pin)) {
		return "a PIN is digits only — it is entered on a telephone keypad";
	}
	if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
		return `a PIN is between ${MIN_PIN_LENGTH} and ${MAX_PIN_LENGTH} digits`;
	}
	if ([...pin].every((digit) => digit === pin[0])) {
		return "a PIN of one repeated digit is among the first an attacker tries";
	}
	if (isStraightRun(pin)) {
		return "a PIN that counts up or down is among the first an attacker tries";
	}
	return undefined;
}

function isStraightRun(pin: string): boolean {
	let ascending = true;
	let descending = true;
	for (let index = 1; index < pin.length; index += 1) {
		const step = Number(pin[index]) - Number(pin[index - 1]);
		if (step !== 1) {
			ascending = false;
		}
		if (step !== -1) {
			descending = false;
		}
	}
	return ascending || descending;
}

/**
 * `POST /voicemail-boxes/:id/pin`.
 *
 * The plaintext PIN travels in the body and nowhere else — never a query parameter, which is the
 * part of a URL proxies and access logs record by default. It is hashed before the request
 * returns and is never stored, never logged and never echoed back.
 */
export const setVoicemailPinDto = z.strictObject({
	pin: z.string().superRefine((value, context) => {
		const issue = voicemailPinIssue(value);
		if (issue !== undefined) {
			context.addIssue({ code: "custom", message: issue });
		}
	}),
});
