/**
 * What this platform refuses to accept as a SIP password.
 *
 * ## Why there is a check at all, when passwords are normally DERIVED
 *
 * `provision-secret.ts` derives every ordinary line's password from a root key, and a derived
 * password cannot be weak. The check exists for the other path: `extension.sip_password_ha1`, which
 * lets an operator set a credential by hand — for a handset that cannot take a provisioned config,
 * for a migration from another PBX, for a lab. That path is exactly where "1234" gets typed.
 *
 * And a weak SIP password is not the ordinary weak-password problem. There is no lockout on a
 * REGISTER, the attack is offline against a digest challenge anybody can elicit, and the prize is
 * the ability to spend the tenant's money on international minutes at a rate the attacker chooses.
 * The whole of `toll-fraud/` exists because this credential leaks; refusing the ones that leak
 * immediately is the cheapest control on that list.
 *
 * ## Length first, classes second, and the deny list is small on purpose
 *
 * The rules are, in the order they are checked:
 *
 * 1. **twelve characters** — the only rule that actually costs an attacker anything. An offline
 *    MD5 digest attack is bounded by keyspace, and length is the term with the exponent on it.
 * 2. **three of four character classes** — lower, upper, digit, other. Not four, because a
 *    four-class rule is the one that produces `Password1!` on every system that has ever had one.
 * 3. **not on a small deny list** — the handful of values that appear in every scanner's dictionary
 *    and in every abandoned lab extension.
 *
 * The deny list is deliberately about twenty entries and is NOT a password-dictionary check. A real
 * one would need a real dictionary, would be a dependency and a data file, and would still be
 * beaten by `Sip2024Phone!`. Its job is to catch the specific values a person types when they are
 * setting up a test extension and mean to change it later — which they do not — not to be a
 * credential-strength service. Anything more is `PbxValidationFailure`'s problem to explain rather
 * than this function's to guess at.
 */

/** Characters below this and the digest is worth brute-forcing. See the header. */
export const MIN_SIP_SECRET_LENGTH = 12;

/** How many of the four character classes a secret must draw on. */
export const REQUIRED_CHARACTER_CLASSES = 3;

/**
 * Values a scanner tries first, lower-cased.
 *
 * Compared after lower-casing and after stripping a trailing run of digits, so `sip12345` and
 * `SIP` collapse to the same entry — the trailing-digits habit is what makes a deny list this small
 * worth having at all.
 */
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

/** Why a secret was refused. Reaches the caller verbatim as the validation failure's detail. */
export type WeakSipSecretReason =
	| "too-short"
	| "too-few-character-classes"
	| "well-known"
	| "repeated-character"
	| "sequential";

/**
 * `undefined` when the secret is acceptable, or the reason it is not.
 *
 * A returned reason rather than a thrown error, so the pure rule is testable without an HTTP layer
 * and so the caller decides which failure type to raise — the same split `toll-fraud.policy.ts`
 * makes for the same reason.
 */
export function weakSipSecretReason(secret: string): WeakSipSecretReason | undefined {
	if (secret.length < MIN_SIP_SECRET_LENGTH) {
		return "too-short";
	}
	if (characterClasses(secret) < REQUIRED_CHARACTER_CLASSES) {
		return "too-few-character-classes";
	}
	if (DENIED_SECRETS.has(normalise(secret))) {
		return "well-known";
	}
	// One character repeated is long and has three classes only if somebody worked at it, but
	// `aaaaaaaaaaaa` passes rule 1 and would otherwise reach a phone.
	if (new Set(secret).size <= 2) {
		return "repeated-character";
	}
	if (isSequential(secret)) {
		return "sequential";
	}
	return undefined;
}

/** A sentence for the caller. Never quotes the secret back. */
export function weakSipSecretMessage(reason: WeakSipSecretReason): string {
	switch (reason) {
		case "too-short":
			return `A SIP password must be at least ${String(MIN_SIP_SECRET_LENGTH)} characters. There is no lockout on a SIP REGISTER, so length is the only thing an offline attack has to work through.`;
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

/**
 * Whether every character steps by one from the last, in either direction.
 *
 * Catches `abcdefghijkl` and `987654321098`, and deliberately nothing cleverer: a partial-run
 * heuristic ("contains six sequential characters") refuses real passphrases that happen to contain
 * `stuv`, and a refusal a person cannot understand is a refusal they route around by picking
 * something worse.
 */
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
