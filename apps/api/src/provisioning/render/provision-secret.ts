import { createHmac } from "node:crypto";

/**
 * The SIP password a rendered configuration carries, derived rather than stored.
 *
 * ## Why derivation and not a column
 *
 * `extension.sip_secret_ref` is a HANDLE into a secret manager, and the schema is explicit that the
 * password itself is never stored in the telephony database. That is the right call and this area
 * is not going to weaken it by adding a `sip_password` column so a template has something to
 * interpolate.
 *
 * The alternative is to make the handle *resolvable* without a secret store: the password is
 * `hmac-sha256(rootKey, "<organizationId>:<secretRef>")`, base64url, truncated. The properties that
 * matter:
 *
 * - **Deterministic.** A phone that re-fetches its configuration gets the password it is already
 *   registered with. A derivation with any randomness in it would silently break every handset on
 *   its next resync.
 * - **Tenant-separated.** The organization id is in the input, so two tenants that somehow chose
 *   the same `secretRef` string do not share a password.
 * - **Rotatable.** Changing `PROVISION_SIP_SECRET_KEY` invalidates every derived password at once,
 *   which is the correct behaviour for a compromised root key and is why the key is a deployment
 *   variable rather than a constant.
 * - **Stores nothing.** No new column, no new table, no second copy of a credential to leak.
 *
 * ## What this is a contract WITH
 *
 * The registrar accepts the same password: the `rpc.sip.v1.credential` responder
 * (`sip-credentials.responder.ts`) computes ha1 from THIS derivation and `apps/sipd` verifies
 * digest auth against it — the root key never leaves the api. Byte-exact parity is pinned by
 * vectors emitted from this function (`emit:sip-vectors`) and asserted in
 * `apps/sipd/internal/credentials/derive_test.go`; a change here without regenerating them is a
 * credential rotation, not a refactor.
 *
 * ## Alphabet
 *
 * base64url, truncated to 24 characters (~144 bits). Deliberately not the full base64 alphabet:
 * `+` and `/` are legal in a SIP password and illegal-in-practice in several vendors' plain-text
 * `.cfg` parsers, and a password a phone cannot store is worse than a shorter one.
 */

/** How many characters of the digest become the password. 24 base64url chars ≈ 144 bits. */
const PASSWORD_LENGTH = 24;

export interface SipSecretDerivationInput {
	readonly rootKey: string;
	readonly organizationId: string;
	/** `extension.sip_secret_ref` or `device_line.sip_secret_ref` — whichever the line resolved to. */
	readonly secretRef: string;
}

export function deriveSipPassword(input: SipSecretDerivationInput): string {
	return createHmac("sha256", input.rootKey)
		.update(`${input.organizationId}:${input.secretRef}`, "utf8")
		.digest("base64url")
		.slice(0, PASSWORD_LENGTH);
}
