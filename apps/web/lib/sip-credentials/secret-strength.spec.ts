import { describe, expect, it } from "bun:test";
import {
	MIN_SIP_SECRET_LENGTH,
	REQUIRED_CHARACTER_CLASSES,
	weakSipSecretMessage,
	weakSipSecretReason,
} from "./secret-strength";

/**
 * The rules mirrored from `apps/api/src/pbx/sip-credentials/sip-secret-strength.ts`.
 *
 * The constants are asserted as VALUES rather than compared against an import, because importing
 * the API module into a browser-package spec is exactly the coupling `lib/` refuses everywhere
 * else. If the server moves one of them this fails, which is the point: the dialog would otherwise
 * go on refusing what the server accepts, or accepting what it refuses.
 */
describe("the weak SIP secret rules", () => {
	it("mirrors the server's thresholds", () => {
		expect(MIN_SIP_SECRET_LENGTH).toBe(12);
		expect(REQUIRED_CHARACTER_CLASSES).toBe(3);
	});

	it("accepts a secret that clears every rule", () => {
		expect(weakSipSecretReason("Kf7#pQr2mZx9")).toBeUndefined();
	});

	it("refuses on length first", () => {
		expect(weakSipSecretReason("Kf7#pQr2")).toBe("too-short");
		expect(weakSipSecretReason("")).toBe("too-short");
	});

	it("refuses fewer than three character classes", () => {
		// Twelve characters, but only lower case and digits.
		expect(weakSipSecretReason("abcdgh123456")).toBe("too-few-character-classes");
	});

	it("refuses the values every scanner tries, including a trailing-digit variant", () => {
		// `normalise` strips a trailing run of digits, which is what makes a deny list this small
		// worth having: `Freeswitch2024` collapses to `freeswitch`.
		expect(weakSipSecretReason("Freeswitch20")).toBe("well-known");
		expect(weakSipSecretReason("Asterisk1234")).toBe("well-known");
	});

	it("refuses one or two characters repeated, by the class rule that reaches them first", () => {
		// `aaaaaaaaaaaa` and `aAaAaAaAaAaA` are long enough and are caught, but they are caught as
		// too-few-character-classes rather than as repeated-character: two distinct characters cannot
		// span three classes, so the repeated-character branch is unreachable from this entry point.
		// That is true of the server's function too, and is asserted rather than papered over.
		expect(weakSipSecretReason("aAaAaAaAaAaA")).toBe("too-few-character-classes");
		expect(weakSipSecretReason("aaaaaaaaaaaa")).toBe("too-few-character-classes");
	});

	it("refuses a run of sequential characters", () => {
		// A single-step run that still spans three classes has to cross the ASCII boundary between
		// digits, punctuation and upper case — which `56789:;<=>?@A` does.
		expect(weakSipSecretReason("56789:;<=>?@A")).toBe("sequential");
		// A descending run is the same rule.
		expect(weakSipSecretReason("A@?>=<;:98765")).toBe("sequential");
		// The obvious alphabet run is caught earlier, by the class rule.
		expect(weakSipSecretReason("abcdefghijkl")).toBe("too-few-character-classes");
	});

	it("refuses a secret longer than the DTO accepts", () => {
		expect(weakSipSecretReason(`Kf7#${"pQr2mZx9".repeat(20)}`)).toBe("too-long");
	});

	it("never quotes the secret back in a message", () => {
		const secret = "Freeswitch20";
		const reason = weakSipSecretReason(secret);
		expect(reason).toBeDefined();
		expect(weakSipSecretMessage(reason!)).not.toContain(secret);
	});
});
