import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The signature on every webhook delivery.
 *
 * ## The header, and why it is shaped this way
 *
 * ```text
 * X-Optimiq-Signature: t=1786185600,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
 * ```
 *
 * `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, lower-case hex. This is Stripe's scheme, adopted
 * verbatim rather than invented, for three reasons that are all about the RECEIVER:
 *
 * 1. **The timestamp is inside the MAC.** Signing the body alone produces a signature that is valid
 *    forever, so anybody who ever observed one delivery can replay it at any time — and a
 *    `channel.answered` replayed six months later is a screen-pop for a call that is not happening.
 *    Binding `t` lets a receiver reject anything outside a tolerance window it chooses, and the
 *    binding is what stops an attacker from simply editing `t` to now.
 * 2. **The version prefix is a migration path.** `v1=` means a second algorithm can ship alongside
 *    the first in the same header (`t=…,v1=…,v2=…`) and receivers can move at their own pace. A
 *    bare hex string cannot be upgraded without breaking every integration at once.
 * 3. **It is the scheme integrators already have code for.** Every webhook receiver written against
 *    Stripe, and most of the libraries, verify exactly this. A novel format would be a novel bug in
 *    somebody else's codebase.
 *
 * ## What is signed is the RAW BODY
 *
 * The bytes that go on the wire, before any re-serialization. `apps/api` already learned this the
 * expensive way on the receiving side — see `main.ts`'s note on `rawBody` and the Telnyx receiver —
 * because `JSON.parse` followed by `JSON.stringify` is not the identity function, and a signature
 * computed over a re-serialized body fails for valid deliveries. Here we are the SENDER, so the rule
 * is the mirror image: {@link signWebhookBody} takes the exact string that will be POSTed, and the
 * caller must not touch it afterwards.
 */

/** The header the signature travels in. */
export const WEBHOOK_SIGNATURE_HEADER = "x-optimiq-signature";

/** The header carrying the event type, so a receiver can route without parsing the body. */
export const WEBHOOK_EVENT_HEADER = "x-optimiq-event";

/** The header carrying the subscription id, so a receiver can tell two of ours apart. */
export const WEBHOOK_SUBSCRIPTION_HEADER = "x-optimiq-subscription";

/** The header carrying the delivery attempt, 1-based. A receiver's own dedupe hint. */
export const WEBHOOK_ATTEMPT_HEADER = "x-optimiq-attempt";

/**
 * Signs one delivery.
 *
 * @param secret the subscription's signing key, as stored
 * @param body the exact bytes that will be POSTed
 * @param timestampSeconds unix seconds; travels in the header and inside the MAC
 */
export function signWebhookBody(secret: string, body: string, timestampSeconds: number): string {
	const signature = createHmac("sha256", secret)
		.update(`${timestampSeconds}.${body}`, "utf8")
		.digest("hex");
	return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * Verifies a header this platform produced. The receiver's half, in one function.
 *
 * Exported and tested here rather than left to documentation, because a scheme nobody on this side
 * can execute is a scheme whose test vector is a guess. It is also what the spec's vector asserts
 * against, so the two halves cannot drift.
 *
 * `toleranceSeconds` is the replay window. Zero disables the age check, which is only ever right in
 * a test.
 */
export function verifyWebhookSignature(
	secret: string,
	body: string,
	header: string,
	nowSeconds: number,
	toleranceSeconds = 300,
): boolean {
	const parts = new Map<string, string>();
	for (const segment of header.split(",")) {
		const separator = segment.indexOf("=");
		if (separator > 0) {
			parts.set(segment.slice(0, separator).trim(), segment.slice(separator + 1).trim());
		}
	}
	const timestamp = Number(parts.get("t"));
	const presented = parts.get("v1");
	if (!Number.isInteger(timestamp) || presented === undefined) {
		return false;
	}
	if (toleranceSeconds > 0 && Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
		return false;
	}
	const expected = createHmac("sha256", secret)
		.update(`${timestamp}.${body}`, "utf8")
		.digest("hex");
	// Length-checked before `timingSafeEqual`, which throws on a mismatch — and a throw is itself a
	// timing signal as well as a crash. The same guard `recording-token.ts` records.
	return (
		expected.length === presented.length &&
		timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(presented, "utf8"))
	);
}

/**
 * A fresh signing secret.
 *
 * 32 bytes of CSPRNG output as base64url, prefixed so that a secret found in a log or a config file
 * is identifiable as one — the same reason every provider prefixes theirs. 256 bits because the
 * secret is an HMAC-SHA256 key and anything shorter is the weakest part of the scheme.
 */
export function generateWebhookSecret(): string {
	return `whsec_${randomBytes(32).toString("base64url")}`;
}
