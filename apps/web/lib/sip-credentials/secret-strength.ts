/**
 * What this platform refuses to accept as a SIP password, mirrored for the browser.
 *
 * ## Mirrored from `apps/api/src/pbx/sip-credentials/sip-secret-strength.ts`
 *
 * Rule for rule, deny-list entry for deny-list entry, and message for message. It is a MIRROR and
 * not the enforcement: the server runs the same check in `SipCredentialRotationService.setSecret`
 * and raises a `PbxValidationFailure` whatever this file says, on the same terms as
 * `lib/permissions.ts` mirroring the permission registry. Hiding a refusal is a courtesy; the
 * server is what makes it true.
 *
 * ## Why mirror it at all rather than let the 422 arrive
 *
 * The typing here is a password, in a dialog, and it is never shown again. A refusal that costs a
 * round trip is a refusal that arrives after the person has stopped thinking about the value they
 * chose, and the natural next move is to shorten it until something is accepted. Refusing on the
 * keystroke — with the same sentence the API would have sent — is what makes the rule feel like a
 * rule rather than a rejection.
 *
 * If the two ever drift the server wins and the user sees its message. `secret-strength.spec.ts`
 * asserts the rules and the deny list against the values the server's own module documents.
 */

/** Characters below this and the digest is worth brute-forcing. */
export const MIN_SIP_SECRET_LENGTH = 12;

/** The DTO's own upper bound, so an over-long value is refused here rather than at the MD5. */
export const MAX_SIP_SECRET_LENGTH = 128;

/** How many of the four character classes a secret must draw on. */
export const REQUIRED_CHARACTER_CLASSES = 3;

/** Values a scanner tries first, lower-cased. Mirrors `DENIED_SECRETS`. */
const DENIED_SECRETS: ReadonlySet<string> = new Set([
	"",
	"password",
	"passwd",
	"secret",
	"sip",
	"sippassword",
	"sipsecret",
	"voip",
	"asterisk",
	"freeswitch",
	"admin",
	"administrator",
	"test",
	"testing",
	"default",
	"changeme",
	"letmein",
	"welcome",
	"qwerty",
	"extension",
	"phone",
	"telephone",
	"optimiq",
]);

export type WeakSipSecretReason =
	| "too-short"
	| "too-long"
	| "too-few-character-classes"
	| "well-known"
	| "repeated-character"
	| "sequential";

/**
 * `undefined` when the secret is acceptable, or the reason it is not.
 *
 * `"too-long"` is the one reason with no counterpart in the server's function, because on the
 * server it is the DTO's `.max(128)` that catches it rather than the strength rule. It is folded in
 * here so the dialog has one place to ask.
 */
export function weakSipSecretReason(secret: string): WeakSipSecretReason | undefined {
	if (secret.length < MIN_SIP_SECRET_LENGTH) {
		return "too-short";
	}
	if (secret.length > MAX_SIP_SECRET_LENGTH) {
		return "too-long";
	}
	if (characterClasses(secret) < REQUIRED_CHARACTER_CLASSES) {
		return "too-few-character-classes";
	}
	if (DENIED_SECRETS.has(normalise(secret))) {
		return "well-known";
	}
	if (new Set(secret).size <= 2) {
		return "repeated-character";
	}
	if (isSequential(secret)) {
		return "sequential";
	}
	return undefined;
}

/** A sentence for the person typing. Never quotes the secret back. */
export function weakSipSecretMessage(reason: WeakSipSecretReason): string {
	switch (reason) {
		case "too-short":
			return `A SIP password must be at least ${String(MIN_SIP_SECRET_LENGTH)} characters. There is no lockout on a SIP REGISTER, so length is the only thing an offline attack has to work through.`;
		case "too-long":
			return `A SIP password must be at most ${String(MAX_SIP_SECRET_LENGTH)} characters.`;
		case "too-few-character-classes":
			return `A SIP password must use at least ${String(REQUIRED_CHARACTER_CLASSES)} of: lower case, upper case, digits, and other characters.`;
		case "well-known":
			return "That password is on the short list of values every SIP scanner tries first.";
		case "repeated-character":
			return "A SIP password must not be one or two characters repeated.";
		default:
			return "A SIP password must not be a run of sequential characters.";
	}
}

function normalise(secret: string): string {
	return secret.toLowerCase().replace(/[0-9]+$/u, "");
}

function characterClasses(secret: string): number {
	let classes = 0;
	if (/[a-z]/u.test(secret)) {
		classes += 1;
	}
	if (/[A-Z]/u.test(secret)) {
		classes += 1;
	}
	if (/[0-9]/u.test(secret)) {
		classes += 1;
	}
	if (/[^a-zA-Z0-9]/u.test(secret)) {
		classes += 1;
	}
	return classes;
}

/** Whether every character steps by one from the last, in either direction. */
function isSequential(secret: string): boolean {
	if (secret.length < 3) {
		return false;
	}
	const step = secret.charCodeAt(1) - secret.charCodeAt(0);
	if (step !== 1 && step !== -1) {
		return false;
	}
	for (let index = 2; index < secret.length; index += 1) {
		if (secret.charCodeAt(index) - secret.charCodeAt(index - 1) !== step) {
			return false;
		}
	}
	return true;
}
