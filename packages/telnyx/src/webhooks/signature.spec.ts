import { describe, expect, it } from "bun:test";
import { TelnyxSignatureError } from "../errors";
import { generateFakeWebhookKeyPair, signFakeTelnyxWebhook } from "../fake/webhook-signer";
import { parseTelnyxPublicKey, verifyTelnyxWebhook } from "./signature";

const keyPair = generateFakeWebhookKeyPair();
const body = JSON.stringify({
	data: { record_type: "event", event_type: "number_order.complete", id: "abc" },
});

function verify(overrides: Partial<Parameters<typeof verifyTelnyxWebhook>[0]> = {}): void {
	const signed = signFakeTelnyxWebhook(keyPair, body);
	verifyTelnyxWebhook({
		rawBody: signed.body,
		signature: signed.signature,
		timestamp: signed.timestamp,
		publicKey: keyPair.publicKeyBase64,
		...overrides,
	});
}

describe("verifyTelnyxWebhook — the accept path", () => {
	it("accepts a delivery signed with the matching key", () => {
		expect(() => verify()).not.toThrow();
	});

	it("accepts a Buffer body identically to a string body", () => {
		const signed = signFakeTelnyxWebhook(keyPair, body);
		expect(() =>
			verifyTelnyxWebhook({
				rawBody: Buffer.from(signed.body, "utf8"),
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
			}),
		).not.toThrow();
	});

	it("accepts a pre-parsed KeyObject, so a caller can validate the key once at boot", () => {
		const key = parseTelnyxPublicKey(keyPair.publicKeyBase64);
		expect(() => verify({ publicKey: key })).not.toThrow();
	});
});

describe("verifyTelnyxWebhook — the reject path", () => {
	it("rejects a missing signature", () => {
		expect(() => verify({ signature: undefined })).toThrow(TelnyxSignatureError);
		try {
			verify({ signature: undefined });
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("missing-signature");
		}
	});

	it("rejects a missing timestamp", () => {
		try {
			verify({ timestamp: undefined });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("missing-timestamp");
		}
	});

	it("rejects a non-numeric timestamp", () => {
		try {
			verify({ timestamp: "yesterday" });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("malformed-timestamp");
		}
	});

	/**
	 * A truncated signature must be reported as malformed, not as a mismatch. `Buffer.from(…,
	 * "base64")` silently returns a short buffer for garbage input, so without the length check this
	 * would look like an attacker with a bad key rather than a client bug.
	 */
	it("rejects a signature that is not 64 decoded bytes", () => {
		try {
			verify({ signature: "AAAA" });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("malformed-signature");
		}
	});

	it("rejects a public key that is not 32 decoded bytes", () => {
		try {
			verify({ publicKey: "AAAA" });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("malformed-public-key");
		}
	});

	it("rejects a signature made with a different key", () => {
		const other = generateFakeWebhookKeyPair();
		const signed = signFakeTelnyxWebhook(other, body);
		try {
			verifyTelnyxWebhook({
				rawBody: signed.body,
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
			});
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("mismatch");
		}
	});

	/**
	 * The single most important negative case: the body is what is signed, so a body altered in
	 * transit must not verify even though the timestamp and signature are untouched.
	 */
	it("rejects a body altered after signing", () => {
		const signed = signFakeTelnyxWebhook(keyPair, body);
		try {
			verifyTelnyxWebhook({
				rawBody: `${signed.body} `,
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
			});
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("mismatch");
		}
	});

	/**
	 * A re-serialized body is the trap Telnyx's own SDK samples fall into: `JSON.parse` followed by
	 * `JSON.stringify` is not the identity function, so a receiver that verifies against the parsed
	 * object rejects valid deliveries. This pins that the raw bytes are what count.
	 */
	it("rejects a re-serialized body whose bytes differ", () => {
		const spaced = `{ "data": { "id": "abc" } }`;
		const signed = signFakeTelnyxWebhook(keyPair, spaced);
		const reserialized = JSON.stringify(JSON.parse(spaced));
		expect(reserialized).not.toBe(spaced);
		try {
			verifyTelnyxWebhook({
				rawBody: reserialized,
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
			});
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("mismatch");
		}
	});

	it("rejects a timestamp outside the tolerance window", () => {
		const past = Math.floor(Date.now() / 1000) - 3600;
		const signed = signFakeTelnyxWebhook(keyPair, body, past);
		try {
			verifyTelnyxWebhook({
				rawBody: signed.body,
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
			});
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("stale-timestamp");
		}
	});

	/**
	 * The future half of the window. A one-sided check would accept a timestamp years ahead, which
	 * hands whoever produced it a replay token valid for as long as they chose.
	 */
	it("rejects a timestamp far in the future", () => {
		const future = Math.floor(Date.now() / 1000) + 3600;
		const signed = signFakeTelnyxWebhook(keyPair, body, future);
		try {
			verifyTelnyxWebhook({
				rawBody: signed.body,
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
			});
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxSignatureError).reason).toBe("stale-timestamp");
		}
	});

	it("accepts a stale delivery when the caller widens the window deliberately", () => {
		const past = Math.floor(Date.now() / 1000) - 3600;
		const signed = signFakeTelnyxWebhook(keyPair, body, past);
		expect(() =>
			verifyTelnyxWebhook({
				rawBody: signed.body,
				signature: signed.signature,
				timestamp: signed.timestamp,
				publicKey: keyPair.publicKeyBase64,
				toleranceSeconds: 7200,
			}),
		).not.toThrow();
	});
});

describe("public key round trip", () => {
	/**
	 * The portal publishes base64 of the RAW 32 bytes; Node needs SPKI DER. The signer strips the
	 * 12-byte prefix and the verifier puts it back, so this asserts the two halves agree — a drift
	 * here would make every signature fail with `malformed-public-key` and look like a rotation.
	 */
	it("parses the raw-32-byte format the Telnyx portal publishes", () => {
		const key = parseTelnyxPublicKey(keyPair.publicKeyBase64);
		const spki = key.export({ format: "der", type: "spki" });
		expect(spki.subarray(spki.length - 32).toString("base64")).toBe(keyPair.publicKeyBase64);
	});
});
