import { createPublicKey, verify } from "node:crypto";
import { TelnyxSignatureError } from "../errors";

/**
 * Telnyx webhook signature verification (Ed25519).
 *
 * ## The scheme
 *
 * Telnyx signs every webhook delivery with an Ed25519 key whose public half is shown in the
 * portal, base64-encoded, on the account's public-key page. Two headers carry the proof:
 *
 * ```
 * telnyx-signature-ed25519: <base64 signature, 64 raw bytes>
 * telnyx-timestamp:         <unix seconds>
 * ```
 *
 * and the signed message is the timestamp and the **raw request body** joined by a single pipe:
 *
 * ```
 * `${telnyx-timestamp}|${rawBody}`
 * ```
 *
 * See `reference/telnyx-api.md` §Webhooks for the doc URL this is pinned to.
 *
 * ## Two things this file refuses to do
 *
 * **It never re-serializes the body.** `JSON.parse` followed by `JSON.stringify` is not the
 * identity function — key order, unicode escaping and number formatting all move — so a signature
 * checked against a re-serialized body fails for valid deliveries and, worse, tempts somebody to
 * "fix" it by skipping the check. The caller must hand over the exact bytes it received; the
 * Fastify raw-body hook in `apps/api` exists for this reason alone.
 *
 * **It never compares with `===`.** `crypto.verify` for Ed25519 is constant-time in the signature,
 * which is the property that matters; nothing here does a string comparison of secrets.
 *
 * ## The timestamp window
 *
 * A signature with no freshness bound is a replay token: an attacker who observed one valid
 * delivery can send it again forever, and "number order completed" replayed at the wrong moment is
 * a state machine driven by a stranger. Five minutes is the tolerance Telnyx documents for its own
 * SDKs and is wide enough for the clock skew of a container that has not talked to NTP recently.
 */

/** Telnyx's documented default tolerance, in seconds. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The header names, spelled once so a caller cannot typo one half of the pair. */
export const TELNYX_SIGNATURE_HEADER = "telnyx-signature-ed25519";
export const TELNYX_TIMESTAMP_HEADER = "telnyx-timestamp";

/** The DER prefix that turns 32 raw Ed25519 public-key bytes into an SPKI document. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * Decodes strict base64, rejecting anything that is not.
 *
 * `Buffer.from(value, "base64")` is famously lenient — it ignores characters it does not
 * recognize and returns a short buffer rather than failing — so a truncated or garbage signature
 * would otherwise reach `verify` as a valid-looking short buffer and be reported as a mismatch
 * rather than as the malformed input it is. The length check afterwards is what makes the
 * distinction observable.
 */
function decodeBase64(value: string, expectedBytes: number): Buffer | undefined {
	const decoded = Buffer.from(value, "base64");
	if (decoded.length !== expectedBytes) {
		return undefined;
	}
	return decoded;
}

/**
 * Turns the portal's base64 public key into a Node `KeyObject`.
 *
 * Exported so a caller can do this once at boot and fail fast on a mistyped key, rather than
 * discovering it on the first webhook — at which point the delivery is already being rejected and
 * the reason looks like an attack.
 */
export function parseTelnyxPublicKey(base64Key: string) {
	const raw = decodeBase64(base64Key.trim(), ED25519_PUBLIC_KEY_BYTES);
	if (raw === undefined) {
		throw new TelnyxSignatureError(
			"malformed-public-key",
			`expected ${ED25519_PUBLIC_KEY_BYTES} base64-decoded bytes`,
		);
	}
	try {
		return createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
			format: "der",
			type: "spki",
		});
	} catch (cause) {
		throw new TelnyxSignatureError(
			"malformed-public-key",
			cause instanceof Error ? cause.message : String(cause),
		);
	}
}

export interface VerifyWebhookInput {
	/** The exact bytes of the request body. Never a re-serialized object — see the header. */
	readonly rawBody: string | Buffer;
	/** Value of `telnyx-signature-ed25519`. */
	readonly signature: string | undefined;
	/** Value of `telnyx-timestamp`. */
	readonly timestamp: string | undefined;
	/** The account's base64 public key, or a pre-parsed `KeyObject`. */
	readonly publicKey: string | ReturnType<typeof createPublicKey>;
	readonly toleranceSeconds?: number;
	/** Injected so the spec can pin "now" without touching the clock. */
	readonly now?: () => number;
}

/**
 * Verifies a delivery, throwing {@link TelnyxSignatureError} with a machine-readable `reason`.
 *
 * Throwing rather than returning a boolean is deliberate: the reason is what a log line needs to
 * distinguish "somebody is probing us" from "our public key is stale after a portal rotation", and
 * a boolean discards it at exactly the moment it is worth the most.
 */
export function verifyTelnyxWebhook(input: VerifyWebhookInput): void {
	if (input.signature === undefined || input.signature.trim().length === 0) {
		throw new TelnyxSignatureError("missing-signature");
	}
	if (input.timestamp === undefined || input.timestamp.trim().length === 0) {
		throw new TelnyxSignatureError("missing-timestamp");
	}

	const timestampText = input.timestamp.trim();
	if (!/^\d{1,15}$/u.test(timestampText)) {
		throw new TelnyxSignatureError("malformed-timestamp", timestampText);
	}
	const timestampSeconds = Number(timestampText);

	const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
	const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
	// Absolute, not one-sided: a timestamp far in the FUTURE is as much a red flag as a stale one,
	// and accepting it would hand an attacker a token that stays valid for as long as they chose.
	if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
		throw new TelnyxSignatureError(
			"stale-timestamp",
			`${Math.abs(nowSeconds - timestampSeconds)}s outside the ${tolerance}s window`,
		);
	}

	const signatureBytes = decodeBase64(input.signature.trim(), ED25519_SIGNATURE_BYTES);
	if (signatureBytes === undefined) {
		throw new TelnyxSignatureError(
			"malformed-signature",
			`expected ${ED25519_SIGNATURE_BYTES} base64-decoded bytes`,
		);
	}

	const key =
		typeof input.publicKey === "string" ? parseTelnyxPublicKey(input.publicKey) : input.publicKey;

	const body =
		typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
	const signedPayload = Buffer.concat([Buffer.from(`${timestampText}|`, "utf8"), body]);

	// Ed25519 is a "pure" signature scheme in Node: the algorithm argument must be null.
	if (!verify(null, signedPayload, key, signatureBytes)) {
		throw new TelnyxSignatureError("mismatch");
	}
}

/** The message Telnyx signs, exposed so the fake server can produce real signatures. */
export function telnyxSignedPayload(timestamp: string, rawBody: string | Buffer): Buffer {
	const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
	return Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), body]);
}
