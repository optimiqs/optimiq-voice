import { describe, expect, it } from "bun:test";
import { regionsForNumber, requiresAllParty } from "./recording-jurisdiction";

/** The shipped default from the recording-consent contract, abbreviated to what these cases need. */
const ALL_PARTY = ["US-CA", "US-FL", "US-IL", "US-MA", "US-PA", "US-WA", "EU"] as const;

describe("regionsForNumber", () => {
	it("resolves a California NPA to the state and then the country", () => {
		expect(regionsForNumber("+14155550100")).toEqual(["US-CA", "US"]);
	});

	it("resolves a New York NPA, which is not an all-party jurisdiction", () => {
		expect(regionsForNumber("+12125550100")).toEqual(["US-NY", "US"]);
		expect(requiresAllParty(["+12125550100"], ALL_PARTY)).toEqual([]);
	});

	it("resolves a Canadian NPA to the province and then the country", () => {
		expect(regionsForNumber("+14165550100")).toEqual(["CA-ON", "CA"]);
	});

	it("resolves a UK number to GB alone, since the UK is not an EU member", () => {
		expect(regionsForNumber("+442071838750")).toEqual(["GB"]);
	});

	it("appends EU to a member state", () => {
		expect(regionsForNumber("+493012345678")).toEqual(["DE", "EU"]);
	});

	it("returns nothing for a toll-free NPA, which names no place", () => {
		expect(regionsForNumber("+18005550100")).toEqual([]);
		expect(regionsForNumber("+18885550100")).toEqual([]);
	});

	it("returns nothing for a string that is not a phone number", () => {
		expect(regionsForNumber("not-a-number")).toEqual([]);
		expect(regionsForNumber("*97")).toEqual([]);
	});

	it("returns nothing for undefined and for empty input", () => {
		expect(regionsForNumber(undefined)).toEqual([]);
		expect(regionsForNumber("")).toEqual([]);
	});

	it("normalises what a carrier actually puts in a From header", () => {
		expect(regionsForNumber("+1 (415) 555-0100")).toEqual(["US-CA", "US"]);
		expect(regionsForNumber("004930123456")).toEqual(["DE", "EU"]);
	});

	it("returns nothing for a +1 number of the wrong length or an unassigned NPA", () => {
		expect(regionsForNumber("+1415555")).toEqual([]);
		expect(regionsForNumber("+13115550100")).toEqual([]);
	});
});

describe("requiresAllParty", () => {
	it("matches a single all-party number", () => {
		expect(requiresAllParty(["+14155550100"], ALL_PARTY)).toEqual(["US-CA"]);
	});

	it("deduplicates when caller and destination sit in the same jurisdiction", () => {
		expect(requiresAllParty(["+14155550100", "+16195550100"], ALL_PARTY)).toEqual(["US-CA"]);
	});

	it("returns the matches in the order the tenant configured them", () => {
		expect(requiresAllParty(["+493012345678", "+14155550100"], ALL_PARTY)).toEqual(["US-CA", "EU"]);
	});

	it("matches case-insensitively and echoes the tenant's own spelling", () => {
		expect(requiresAllParty(["+14155550100"], ["us-ca"])).toEqual(["us-ca"]);
		expect(requiresAllParty(["+493012345678"], ["eu"])).toEqual(["eu"]);
	});

	it("skips an unknown caller ID rather than failing the call", () => {
		expect(requiresAllParty([undefined, "+14155550100"], ALL_PARTY)).toEqual(["US-CA"]);
		expect(requiresAllParty([undefined, undefined], ALL_PARTY)).toEqual([]);
	});

	it("decides nothing when the tenant configured no regions", () => {
		expect(requiresAllParty(["+14155550100"], [])).toEqual([]);
	});

	it("matches a broader region when that is what the tenant listed", () => {
		expect(requiresAllParty(["+14155550100"], ["US"])).toEqual(["US"]);
	});
});
