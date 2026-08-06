import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { telnyxSignedPayload } from "../webhooks/signature";

/**
 * Produces real Ed25519 signatures in Telnyx's format, so the receiver can be tested against
 * cryptography rather than against a stubbed verifier.
 *
 * The distinction matters more than it looks. A test that stubs `verifyTelnyxWebhook` to return
 * `true` proves the controller calls *something*; it cannot catch a payload assembled as
 * `timestamp + body` instead of `timestamp|body`, a base64 decode of the wrong field, or a
 * verifier wired to the wrong header — which are exactly the mistakes this scheme invites. Signing
 * for real means the accept path and the reject path are both proven end to end.
 */

export interface FakeWebhookKeyPair {
	readonly privateKey: KeyObject;
	/** Base64 of the raw 32 public-key bytes — the format the Telnyx portal shows. */
	readonly publicKeyBase64: string;
}

/**
 * Generates a key pair and exports the public half the way Telnyx publishes it.
 *
 * The export goes through DER/SPKI and then slices the trailing 32 bytes, because Node has no
 * "raw" export for Ed25519. The 12-byte prefix it strips is the same one `signature.ts` puts back;
 * that symmetry is deliberate, and a spec asserts the round trip.
 */
export function generateFakeWebhookKeyPair(): FakeWebhookKeyPair {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ format: "der", type: "spki" });
	const raw = spki.subarray(spki.length - 32);
	return { privateKey, publicKeyBase64: raw.toString("base64") };
}

export interface FakeSignedWebhook {
	readonly body: string;
	readonly signature: string;
	readonly timestamp: string;
}

/**
 * Signs a body exactly as Telnyx would.
 *
 * `body` is taken as a string, never as an object, so a caller cannot accidentally sign one
 * serialization and send another — the failure mode Telnyx's own SDK samples fall into.
 */
export function signFakeTelnyxWebhook(
	keyPair: FakeWebhookKeyPair,
	body: string,
	timestampSeconds: number = Math.floor(Date.now() / 1000),
): FakeSignedWebhook {
	const timestamp = String(timestampSeconds);
	const signature = sign(null, telnyxSignedPayload(timestamp, body), keyPair.privateKey);
	return { body, signature: signature.toString("base64"), timestamp };
}
