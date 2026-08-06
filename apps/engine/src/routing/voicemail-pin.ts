import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { parseVoicemailPinHash, scryptMemoryBytes } from "@optimiq-voice/routing";
import type { VoicemailPinScryptParams } from "@optimiq-voice/routing";

/**
 * Verifying a caller's digits against the PIN digest the artifact carries.
 *
 * `packages/routing` owns the FORMAT and validates it; this owns the CHECK. The split is not
 * ceremony: the compiler is a pure function that must not acquire a KDF on its import graph, and
 * the engine is the only process that ever has a caller's digits in hand.
 *
 * ## Everything here is about not leaking
 *
 * Three properties, in the order they matter:
 *
 * 1. **The comparison is constant-time.** `===` on two digests leaks the length of the matching
 *    prefix through timing, and a mailbox PIN is short enough for that to be a real attack rather
 *    than an academic one.
 * 2. **The parameters come from the digest, not from here.** A digest written under an older cost
 *    verifies under that cost. This is what makes raising the default a re-hash on next set rather
 *    than a flag day that locks every user out of their mailbox at once.
 * 3. **A malformed digest fails closed.** `packages/routing` already refuses to embed one, so
 *    reaching this with garbage means the artifact was written by something that skipped that
 *    check — at which point "no" is the only answer that is not a guess.
 *
 * ## Why the work is bounded
 *
 * scrypt with `N=16384, r=8` is ~16 MB and a few milliseconds. That is deliberate on the call path
 * and it is also why `packages/routing` bounds the parameters at parse time: an unbounded `N` in a
 * digest would be a caller-triggered allocation, and the failure mode of that is not "one login
 * fails" but "the engine process dies and takes every live call with it".
 */

/** Why a PIN attempt failed. Never surfaced to the caller — a caller hears "incorrect". */
export type VoicemailPinFailure =
	/** The digest is not in the documented format. Fails closed. */
	| "malformed-hash"
	/** Digits were empty or not digits. */
	| "empty-pin"
	/** A correct-shaped attempt that simply did not match. */
	| "mismatch"
	/** The KDF itself failed. Fails closed, and is worth a log line. */
	| "kdf-error";

export type VoicemailPinResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly failure: VoicemailPinFailure };

/**
 * Whether `pin` is the secret behind `pinHash`.
 *
 * Never throws: this runs inside a call walk, and an exception out of one would end a call that
 * should merely have been told "incorrect PIN".
 *
 * Named for voicemail because voicemail is where the format came from, but it is not
 * voicemail-specific and must not become so: `ConferencePlanNode.pinHash` and
 * `ConferencePlanNode.moderatorPinHash` are digests in the same format written by the same API
 * endpoint, and a second implementation of "check a scrypt digest in constant time" is a second
 * place for the fail-open bug to live. {@link verifyPinDigest} is the neutral name; both are the
 * same function.
 */
export async function verifyVoicemailPin(
	pin: string,
	pinHash: string,
): Promise<VoicemailPinResult> {
	const digits = pin.trim();
	if (digits === "") {
		return { ok: false, failure: "empty-pin" };
	}

	const parsed = parseVoicemailPinHash(pinHash);
	if (parsed === undefined) {
		return { ok: false, failure: "malformed-hash" };
	}

	let expected: Buffer;
	let salt: Buffer;
	try {
		expected = Buffer.from(parsed.hashBase64, "base64");
		salt = Buffer.from(parsed.saltBase64, "base64");
	} catch {
		return { ok: false, failure: "malformed-hash" };
	}

	let derived: Buffer;
	try {
		derived = await deriveKey(digits, salt, expected.length, parsed.params);
	} catch {
		return { ok: false, failure: "kdf-error" };
	}

	// Lengths are equal by construction — the derived key is requested at the expected key's length
	// — but `timingSafeEqual` throws on a mismatch, and a throw here would be a fail-OPEN if anyone
	// ever wrapped this in a permissive catch. Checking first keeps the failure a "no".
	if (derived.length !== expected.length) {
		return { ok: false, failure: "mismatch" };
	}
	return timingSafeEqual(derived, expected) ? { ok: true } : { ok: false, failure: "mismatch" };
}

/**
 * {@link verifyVoicemailPin} under the name the rest of the engine should use.
 *
 * One verifier, three call sites (`*97`, a conference participant PIN, a conference moderator
 * PIN) and therefore one place where the constant-time comparison, the digest-sourced parameters
 * and the fail-closed behaviour are decided. An alias rather than a rename because the voicemail
 * name is what the `*97` path and its specs already say, and churning them proves nothing.
 */
export const verifyPinDigest = verifyVoicemailPin;

/** {@link VoicemailPinResult} under the neutral name. */
export type PinDigestResult = VoicemailPinResult;

/** {@link VoicemailPinFailure} under the neutral name. */
export type PinDigestFailure = VoicemailPinFailure;

function deriveKey(
	pin: string,
	salt: Buffer,
	keyLength: number,
	params: VoicemailPinScryptParams,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(
			pin,
			salt,
			keyLength,
			{
				N: params.cost,
				r: params.blockSize,
				p: params.parallelism,
				// Node's default `maxmem` is 32 MB, which the recommended parameters (~16 MB) fit under
				// but a legitimately stronger digest would not — and a digest that is refused by an
				// allocator limit nobody wrote down looks exactly like a wrong PIN.
				//
				// Sized from the digest's own parameters, with headroom, so the ONLY bound that can
				// refuse a digest is `MAX_MEMORY_BYTES` in `packages/routing` — enforced at parse time,
				// written down, and tested. One bound, in one place.
				maxmem: scryptMemoryBytes(params) * 2,
			},
			(error, key) => {
				// `!= null`, not `!== null`: Node's callback passes `null` on success and Bun's passes
				// `undefined`. A strict null check therefore rejects every successful derivation under
				// Bun — which is what the engine's own test runner is — and the failure surfaces as
				// "every PIN is wrong" rather than as anything that looks like a bug in this line.
				if (error != null) {
					reject(error);
					return;
				}
				resolve(key);
			},
		);
	});
}
