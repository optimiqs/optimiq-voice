import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedSecret,
	loadSecretKey,
	openStoredSecret,
	requireSecretKey,
	SECRET_ENCRYPTION_KEY_VARIABLE,
	SecretCipherError,
	secretsEqual,
} from "./secret-cipher";

const KEY = randomBytes(32);

describe("secret-cipher", () => {
	it("round-trips a secret", () => {
		const sealed = encryptSecret("s3cr3t-client-value", KEY);
		expect(decryptSecret(sealed, KEY)).toBe("s3cr3t-client-value");
	});

	it("round-trips unicode and the empty string", () => {
		for (const plaintext of ["", "ünïcødé — ✓", "a".repeat(4096)]) {
			expect(decryptSecret(encryptSecret(plaintext, KEY), KEY)).toBe(plaintext);
		}
	});

	it("never produces the same ciphertext twice for the same input", () => {
		const first = encryptSecret("same", KEY);
		const second = encryptSecret("same", KEY);
		expect(first).not.toBe(second);
		expect(decryptSecret(first, KEY)).toBe(decryptSecret(second, KEY));
	});

	it("does not leak the plaintext into the ciphertext", () => {
		expect(encryptSecret("needle", KEY)).not.toContain("needle");
	});

	it("refuses a ciphertext sealed under a different key", () => {
		const sealed = encryptSecret("s3cr3t", KEY);
		expect(() => decryptSecret(sealed, randomBytes(32))).toThrow(SecretCipherError);
	});

	it("refuses a tampered ciphertext rather than returning garbage", () => {
		const parts = encryptSecret("s3cr3t", KEY).split(".");
		const body = Buffer.from(parts[6]!, "base64url");
		body[0] = body[0]! ^ 0xff;
		parts[6] = body.toString("base64url");
		expect(() => decryptSecret(parts.join("."), KEY)).toThrow(SecretCipherError);
	});

	it("refuses a ciphertext whose wrapped data key was swapped for another record's", () => {
		const mine = encryptSecret("mine", KEY).split(".");
		const theirs = encryptSecret("theirs", KEY).split(".");
		mine[1] = theirs[1]!;
		expect(() => decryptSecret(mine.join("."), KEY)).toThrow(SecretCipherError);
	});

	it("recognises its own ciphertexts and nothing else", () => {
		expect(isEncryptedSecret(encryptSecret("x", KEY))).toBe(true);
		expect(isEncryptedSecret("plain-legacy-secret")).toBe(false);
		expect(isEncryptedSecret("v1.only.four.parts")).toBe(false);
		expect(isEncryptedSecret("v2.a.b.c.d.e.f")).toBe(false);
	});

	it("passes a legacy plaintext row through untouched", () => {
		expect(openStoredSecret("legacy-plaintext", KEY)).toEqual({
			plaintext: "legacy-plaintext",
			wasEncrypted: false,
		});
	});

	it("opens an encrypted row and says so", () => {
		expect(openStoredSecret(encryptSecret("sealed", KEY), KEY)).toEqual({
			plaintext: "sealed",
			wasEncrypted: true,
		});
	});

	it("refuses to open an encrypted row with no key configured", () => {
		expect(() => openStoredSecret(encryptSecret("sealed", KEY), null)).toThrow(SecretCipherError);
	});

	it("reads a hex or base64 key from the environment and treats blank as unset", () => {
		const hex = KEY.toString("hex");
		expect(loadSecretKey({ [SECRET_ENCRYPTION_KEY_VARIABLE]: hex })!.equals(KEY)).toBe(true);
		expect(
			loadSecretKey({ [SECRET_ENCRYPTION_KEY_VARIABLE]: KEY.toString("base64") })!.equals(KEY),
		).toBe(true);
		expect(loadSecretKey({})).toBeNull();
		expect(loadSecretKey({ [SECRET_ENCRYPTION_KEY_VARIABLE]: "   " })).toBeNull();
	});

	it("refuses a key that is the wrong length", () => {
		expect(() => loadSecretKey({ [SECRET_ENCRYPTION_KEY_VARIABLE]: "too-short" })).toThrow(
			SecretCipherError,
		);
	});

	it("requireSecretKey refuses to let a write path store plaintext", () => {
		expect(() => requireSecretKey({})).toThrow(SecretCipherError);
		expect(requireSecretKey({ [SECRET_ENCRYPTION_KEY_VARIABLE]: KEY.toString("hex") })).toEqual(
			KEY,
		);
	});

	it("compares secrets without leaking length-independent timing", () => {
		expect(secretsEqual("abc", "abc")).toBe(true);
		expect(secretsEqual("abc", "abd")).toBe(false);
		expect(secretsEqual("abc", "abcd")).toBe(false);
	});
});
