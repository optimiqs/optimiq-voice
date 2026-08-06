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
 * The registrar has to accept the same password. Today nothing consumes
 * `extension.sip_password_ha1` — the credential pipeline is not built on either side — so this
 * function is the *first* statement of what the shared derivation is, and it is exported precisely
 * so `apps/sipd` can adopt it verbatim rather than inventing a second one. Until it does, a
 * provisioned phone renders a correct-looking configuration whose password nothing yet checks.
 * That is recorded as a follow-up rather than hidden: the alternative was to ship a template with
 * an empty password field, which fails later and more confusingly.
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
