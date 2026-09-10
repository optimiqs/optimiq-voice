import { describe, expect, it } from "bun:test";
import { describeE164Rejection, E164_REJECTIONS, isE164, normalizeE164, toE164 } from "./e164";

describe("isE164", () => {
	it("accepts the canonical form and nothing else", () => {
		expect(isE164("+12125550100")).toBe(true);
		expect(isE164("+441632960001")).toBe(true);
		expect(isE164("2125550100")).toBe(false);
		expect(isE164("+02125550100")).toBe(false);
		expect(isE164("+1")).toBe(false);
		expect(isE164("+1234567890123456")).toBe(false);
		expect(isE164(" +12125550100")).toBe(false);
	});
});

describe("normalizeE164 — already international", () => {
	it("passes a canonical number through unchanged", () => {
		expect(normalizeE164("+12125550100")).toEqual({ ok: true, e164: "+12125550100" });
	});

	it("strips the punctuation and whitespace a person types", () => {
		for (const typed of [
			"+1 (212) 555-0100",
			"+1.212.555.0100",
			"  +1 212 555 0100  ",
			"+1-212-555-0100",
			"+1 212 555 0100",
		]) {
			expect(normalizeE164(typed)).toEqual({ ok: true, e164: "+12125550100" });
		}
	});

	it("reads the ITU and NANP international access prefixes as a +", () => {
		expect(normalizeE164("0012125550100")).toEqual({ ok: true, e164: "+12125550100" });
		expect(normalizeE164("01112125550100")).toEqual({ ok: true, e164: "+12125550100" });
		expect(normalizeE164("00 44 1632 960001")).toEqual({ ok: true, e164: "+441632960001" });
	});
});

describe("normalizeE164 — national input", () => {
	it("prepends the default calling code", () => {
		expect(normalizeE164("2125550100", { defaultCallingCode: "1" })).toEqual({
			ok: true,
			e164: "+12125550100",
		});
		expect(normalizeE164("(212) 555-0100", { defaultCallingCode: "1" })).toEqual({
			ok: true,
			e164: "+12125550100",
		});
	});

	it("drops the NANP long-distance 1 rather than doubling the country code", () => {
		expect(normalizeE164("12125550100", { defaultCallingCode: "1" })).toEqual({
			ok: true,
			e164: "+12125550100",
		});
		expect(normalizeE164("1-212-555-0100", { defaultCallingCode: "1" })).toEqual({
			ok: true,
			e164: "+12125550100",
		});
	});

	it("keeps a 10-digit NANP number whose area code merely contains a 1", () => {
		expect(normalizeE164("2125550101", { defaultCallingCode: "1" })).toEqual({
			ok: true,
			e164: "+12125550101",
		});
	});

	it("drops the domestic trunk zero outside NANP", () => {
		expect(normalizeE164("01632960001", { defaultCallingCode: "44" })).toEqual({
			ok: true,
			e164: "+441632960001",
		});
		expect(normalizeE164("1632960001", { defaultCallingCode: "44" })).toEqual({
			ok: true,
			e164: "+441632960001",
		});
	});

	it("refuses a national number when no default country is configured", () => {
		expect(normalizeE164("2125550100")).toEqual({ ok: false, reason: "no-country-code" });
	});

	it("refuses a default calling code that is not one", () => {
		for (const code of ["", "0", "+1", "abc", "12345"]) {
			expect(normalizeE164("2125550100", { defaultCallingCode: code })).toEqual({
				ok: false,
				reason: "no-country-code",
			});
		}
	});
});

describe("normalizeE164 — refusals", () => {
	it("refuses an empty or punctuation-only string", () => {
		expect(normalizeE164("")).toEqual({ ok: false, reason: "empty" });
		expect(normalizeE164("   ")).toEqual({ ok: false, reason: "empty" });
		expect(normalizeE164("()- ")).toEqual({ ok: false, reason: "empty" });
	});

	it("refuses letters and dial-plan characters", () => {
		expect(normalizeE164("+1212555010A")).toEqual({ ok: false, reason: "not-a-number" });
		expect(normalizeE164("*97")).toEqual({ ok: false, reason: "not-a-number" });
		expect(normalizeE164("+1#2125550100")).toEqual({ ok: false, reason: "not-a-number" });
	});

	it("refuses a + in front of a domestic trunk prefix", () => {
		expect(normalizeE164("+01632960001")).toEqual({ ok: false, reason: "not-a-number" });
	});

	it("refuses numbers outside E.164's length bounds", () => {
		expect(normalizeE164("+1")).toEqual({ ok: false, reason: "too-short" });
		expect(normalizeE164(`+${"9".repeat(16)}`)).toEqual({ ok: false, reason: "too-long" });
		expect(normalizeE164(`+${"9".repeat(15)}`).ok).toBe(true);
	});
});

describe("normalizeE164 — idempotence", () => {
	it("is a no-op on its own output", () => {
		for (const typed of ["+1 (212) 555-0100", "2125550100", "0012125550100", "12125550100"]) {
			const once = toE164(typed, { defaultCallingCode: "1" });
			expect(once).not.toBeNull();
			expect(toE164(once!, { defaultCallingCode: "1" })).toBe(once);
		}
	});
});

describe("toE164", () => {
	it("returns the number or null", () => {
		expect(toE164("+1 212 555 0100")).toBe("+12125550100");
		expect(toE164("nonsense")).toBeNull();
	});
});

describe("describeE164Rejection", () => {
	it("has a sentence for every reason", () => {
		for (const reason of E164_REJECTIONS) {
			expect(describeE164Rejection(reason).length).toBeGreaterThan(0);
		}
	});
});
