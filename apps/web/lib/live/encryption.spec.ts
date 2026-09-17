import { describe, expect, it } from "bun:test";
import { encryptedLegCount, encryptionLabel, isLegEncrypted } from "./encryption";

describe("isLegEncrypted", () => {
	it("is true only when the engine wrote the flag", () => {
		expect(isLegEncrypted({ flags: ["answered", "encrypted"] })).toBe(true);
		expect(isLegEncrypted({ flags: ["answered"] })).toBe(false);
	});

	/**
	 * A leg with no flags at all is one nothing has negotiated yet. It answers `false` — which is
	 * safe, because the padlock is drawn only for `true` — and it is the caller's job not to ask
	 * while a call is ringing.
	 */
	it("is false for a leg with no flags, and for no leg at all", () => {
		expect(isLegEncrypted({})).toBe(false);
		expect(isLegEncrypted(undefined)).toBe(false);
	});
});

describe("encryptedLegCount", () => {
	/**
	 * Legs, not calls: one bridged call can be an encrypted handset leg and a plaintext carrier leg,
	 * and there is no single answer for the call as a whole.
	 */
	it("counts legs, and the two halves of one call separately", () => {
		expect(
			encryptedLegCount([
				{ flags: ["answered", "encrypted"] },
				{ flags: ["answered"] },
				{ flags: ["encrypted"] },
			]),
		).toEqual({ encrypted: 2, total: 3 });
	});

	it("is zero over an empty feed rather than undefined", () => {
		expect(encryptedLegCount([])).toEqual({ encrypted: 0, total: 0 });
	});
});

describe("encryptionLabel", () => {
	it("says what is encrypted, and never that the call is safe", () => {
		expect(encryptionLabel(true)).toContain("SRTP");
		expect(encryptionLabel(true)).not.toContain("Secure");
		expect(encryptionLabel(false)).toContain("plain RTP");
	});
});
