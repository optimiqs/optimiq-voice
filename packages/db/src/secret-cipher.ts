import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for the handful of columns that hold a credential this platform must be able
 * to PRESENT again — today that is `organization_sso_provider.client_secret`.
 *
 * ## Why this is not the SIP seam
 *
 * `provision-secret.ts` derives a SIP password with an HMAC and never stores one, which is the
 * right shape when the platform gets to CHOOSE the secret. An IdP's client secret is chosen by
 * somebody else and handed to us, so it has to survive a round trip: the auth boot presents it to
 * the IdP verbatim. Derivation cannot do that, and a hash cannot either. Encryption is the only
 * remaining answer.
 *
 * ## Why an envelope rather than encrypting under the platform key directly
 *
 * Each record gets its own single-use data key (DEK), and only that DEK is sealed under the
 * platform key (KEK). Two things follow. The KEK encrypts a fixed 32 bytes per row instead of
 * attacker-influenced plaintext of unbounded length, which is what keeps its GCM nonce budget
 * uninteresting. And rotating the KEK is a re-wrap of the DEKs rather than a decrypt-and-re-encrypt
 * of every secret — the plaintext never has to be materialised to move to a new key.
 *
 * ## Format
 *
 * `v1.<wrappedDek>.<wrapIv>.<wrapTag>.<iv>.<tag>.<ciphertext>`, every field base64url. The version
 * prefix is what makes {@link isEncryptedSecret} decidable, and that in turn is what lets the
 * readers migrate rows lazily: a value that does not carry the prefix is a legacy plaintext row and
 * is returned as-is, so a deployment that has not run the one-shot migration still signs in.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

/** Raised when the platform key is absent or malformed, and when a ciphertext will not open. */
export class SecretCipherError extends Error {
	readonly _tag = "SecretCipherError" as const;

	constructor(message: string) {
		super(message);
		this.name = "SecretCipherError";
	}
}

/** The env var holding the platform key: 32 bytes as 64 hex chars or as base64. */
export const SECRET_ENCRYPTION_KEY_VARIABLE = "PLATFORM_SECRET_ENCRYPTION_KEY";

function decodeKey(raw: string): Buffer {
	const trimmed = raw.trim();
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		return Buffer.from(trimmed, "hex");
	}
	const decoded = Buffer.from(trimmed, "base64");
	if (decoded.length !== KEY_BYTES) {
		throw new SecretCipherError(
			`${SECRET_ENCRYPTION_KEY_VARIABLE} must decode to ${KEY_BYTES} bytes — 64 hex characters or base64.`,
		);
	}
	return decoded;
}

/**
 * The platform key from the environment, or `null` when it is unset.
 *
 * `null` rather than a throw because the readers have a meaningful answer without one: on a
 * deployment that has never configured a key every stored secret is legacy plaintext, and refusing
 * to boot would take SSO down to fix a problem that key does not yet have. The WRITERS are the ones
 * that must not be lenient — see {@link requireSecretKey}.
 */
export function loadSecretKey(source: NodeJS.ProcessEnv = process.env): Buffer | null {
	const raw = source[SECRET_ENCRYPTION_KEY_VARIABLE];
	if (!raw || raw.trim().length === 0) {
		return null;
	}
	return decodeKey(raw);
}

/** {@link loadSecretKey}, but a missing key is an error. What every write path uses. */
export function requireSecretKey(source: NodeJS.ProcessEnv = process.env): Buffer {
	const key = loadSecretKey(source);
	if (!key) {
		throw new SecretCipherError(
			`${SECRET_ENCRYPTION_KEY_VARIABLE} is not set; refusing to store a credential in plaintext.`,
		);
	}
	return key;
}

/** Whether a stored column value is a {@link encryptSecret} ciphertext rather than legacy plaintext. */
export function isEncryptedSecret(value: string): boolean {
	return value.startsWith(`${VERSION}.`) && value.split(".").length === 7;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
	if (key.length !== KEY_BYTES) {
		throw new SecretCipherError(`Platform key must be ${KEY_BYTES} bytes.`);
	}
	const dek = randomBytes(KEY_BYTES);
	const wrapIv = randomBytes(IV_BYTES);
	const wrap = createCipheriv(ALGORITHM, key, wrapIv);
	const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
	const wrapTag = wrap.getAuthTag();

	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, dek, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	dek.fill(0);

	return [VERSION, wrappedDek, wrapIv, wrapTag, iv, tag, ciphertext]
		.map((part) => (typeof part === "string" ? part : part.toString("base64url")))
		.join(".");
}

export function decryptSecret(value: string, key: Buffer): string {
	const parts = value.split(".");
	if (parts.length !== 7 || parts[0] !== VERSION) {
		throw new SecretCipherError("Not a v1 envelope ciphertext.");
	}
	const [, wrappedDek, wrapIv, wrapTag, iv, tag, ciphertext] = parts.map((part) =>
		Buffer.from(part, "base64url"),
	) as unknown as Buffer[];

	try {
		const unwrap = createDecipheriv(ALGORITHM, key, wrapIv!);
		unwrap.setAuthTag(wrapTag!);
		const dek = Buffer.concat([unwrap.update(wrappedDek!), unwrap.final()]);
		const decipher = createDecipheriv(ALGORITHM, dek, iv!);
		decipher.setAuthTag(tag!);
		const plaintext = Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString(
			"utf8",
		);
		dek.fill(0);
		return plaintext;
	} catch {
		// Deliberately not chained: GCM's own failure message says nothing useful and a `cause` on a
		// crypto error is one more thing a log line can carry a fragment of a key in.
		throw new SecretCipherError("Ciphertext failed authentication; wrong key or tampered value.");
	}
}

/**
 * Open a stored column value: a ciphertext is decrypted, a legacy plaintext row is returned as-is.
 *
 * The lazy half of the migration. A caller that gets `{ migrated: false }` back is holding a row
 * that still needs re-encrypting, and the SSO repository re-writes it on the spot.
 */
export function openStoredSecret(
	value: string,
	key: Buffer | null,
): { readonly plaintext: string; readonly wasEncrypted: boolean } {
	if (!isEncryptedSecret(value)) {
		return { plaintext: value, wasEncrypted: false };
	}
	if (!key) {
		throw new SecretCipherError(
			`A stored secret is encrypted but ${SECRET_ENCRYPTION_KEY_VARIABLE} is not set.`,
		);
	}
	return { plaintext: decryptSecret(value, key), wasEncrypted: true };
}

/** Constant-time equality for the two places that compare a secret rather than present it. */
export function secretsEqual(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}
