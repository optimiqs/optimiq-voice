import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The provisioning token: what a phone presents instead of a session.
 *
 * ## The shape, and why it has two halves
 *
 * `<reference>.<secret>` — 22 base64url characters, a dot, 43 base64url characters. The reference
 * is a lookup handle stored in plaintext in `device.provisioning_token`; the secret is stored only
 * as its SHA-256 in `device.provisioning_token_hash`.
 *
 * A single opaque secret would have had to be stored in plaintext to be *findable*: the request
 * arrives with no tenant context, so the only way to resolve it is an indexed equality lookup, and
 * you cannot index a lookup against a value you did not keep. Splitting the token means the indexed
 * value is not a credential and the credential is not indexed — the standard API-key construction,
 * for the standard reason. A leaked database backup then contains references and digests, neither
 * of which provisions a phone.
 *
 * ## Why the digests are compared in constant time
 *
 * The lookup by reference is an ordinary index probe and leaks nothing useful: the reference is not
 * secret. The SECRET comparison is `timingSafeEqual` over the two 32-byte digests, so the number of
 * matching leading bytes is not observable in the response time. This matters less for a hashed
 * comparison than for a plaintext one — an attacker who learns a digest prefix has learned nothing
 * about the preimage — but the comparison is one line either way, and a future change that stores
 * something weaker inherits the right primitive rather than the wrong one.
 *
 * ## Entropy
 *
 * 32 bytes of `randomBytes` in the secret. At the endpoint's rate limit (a dozen attempts per
 * minute per reference, and a wrong reference never reaches the comparison at all) guessing is not
 * a threat model, it is a rounding error.
 */

/** Characters in the reference half. 16 bytes of randomness, base64url, unpadded. */
const REFERENCE_BYTES = 16;
/** Characters in the secret half. 32 bytes of randomness, base64url, unpadded. */
const SECRET_BYTES = 32;

/** The separator. A dot is safe in a URL path segment and in every vendor's fetch implementation. */
const SEPARATOR = ".";

export interface MintedProvisioningToken {
	/** The whole `<reference>.<secret>` string. Shown to an administrator ONCE and never stored. */
	readonly token: string;
	/** Goes into `device.provisioning_token`. Not a secret. */
	readonly reference: string;
	/** Goes into `device.provisioning_token_hash`. */
	readonly secretHash: string;
}

export function mintProvisioningToken(): MintedProvisioningToken {
	const reference = randomBytes(REFERENCE_BYTES).toString("base64url");
	const secret = randomBytes(SECRET_BYTES).toString("base64url");
	return {
		token: `${reference}${SEPARATOR}${secret}`,
		reference,
		secretHash: sha256Hex(secret),
	};
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface ParsedProvisioningToken {
	readonly reference: string;
	readonly secret: string | undefined;
}

/**
 * Splits a presented token into the half that is looked up and the half that is verified.
 *
 * A token with no separator is a LEGACY token — a whole plaintext value written before the split —
 * and is returned with `secret: undefined`. The resolver accepts that shape only against a row
 * whose `provisioning_token_hash` is NULL, so a rotated device cannot be reached by its old,
 * shorter token even if that token is still somebody's clipboard.
 *
 * Returns `undefined` for anything that is not plausibly a token at all (empty, absurdly long,
 * characters outside base64url and the separator). That check is not security — the lookup would
 * simply miss — it is what keeps a 4 KB path segment out of a database query.
 */
export function parseProvisioningToken(presented: string): ParsedProvisioningToken | undefined {
	if (presented.length === 0 || presented.length > 256) {
		return undefined;
	}
	if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u.test(presented)) {
		return undefined;
	}
	const separator = presented.indexOf(SEPARATOR);
	if (separator === -1) {
		return { reference: presented, secret: undefined };
	}
	return {
		reference: presented.slice(0, separator),
		secret: presented.slice(separator + 1),
	};
}

/**
 * Whether a presented secret matches a stored digest, in constant time.
 *
 * Both operands are hex-decoded to fixed-width buffers first: `timingSafeEqual` throws on a length
 * mismatch, and a throw is itself a timing signal. A stored digest that is not 32 bytes of hex is a
 * corrupt row and is refused rather than compared.
 */
export function secretMatchesHash(secret: string, storedHash: string): boolean {
	if (!/^[0-9a-f]{64}$/u.test(storedHash)) {
		return false;
	}
	const presented = Buffer.from(sha256Hex(secret), "hex");
	const stored = Buffer.from(storedHash, "hex");
	return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/** The URL a phone fetches, given the deployment's public base and a minted token. */
export function provisioningConfigUrl(baseUrl: string, token: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/provision/${token}/config`;
}

/** The softphone payload URL for the same token. */
export function provisioningPayloadUrl(baseUrl: string, token: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/provision/${token}/payload`;
}
