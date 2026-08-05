import { describe, expect, it } from "bun:test";
import { isEntityId } from "@optimiq-voice/identifiers";
import { callIdForAriChannel, legIdForAriChannel, resolveOrganizationId } from "./channel-identity";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";

describe("legIdForAriChannel", () => {
	it("produces a valid entity id", () => {
		expect(isEntityId(legIdForAriChannel("1754400000.42"))).toBe(true);
	});

	it("is deterministic — the whole reason it is not a random id in a Map", () => {
		expect(legIdForAriChannel("1754400000.42")).toBe(legIdForAriChannel("1754400000.42"));
	});

	it("distinguishes the two halves of a Local channel pair", () => {
		expect(legIdForAriChannel("1754400000.42;1")).not.toBe(legIdForAriChannel("1754400000.42;2"));
	});

	it("distinguishes different channels", () => {
		expect(legIdForAriChannel("a")).not.toBe(legIdForAriChannel("b"));
	});

	it("rejects an empty id", () => {
		expect(() => legIdForAriChannel("")).toThrow(TypeError);
		expect(() => legIdForAriChannel("   ")).toThrow(TypeError);
	});
});

describe("callIdForAriChannel", () => {
	it("is deterministic and distinct from the leg id of the same channel", () => {
		expect(callIdForAriChannel("1754400000.42")).toBe(callIdForAriChannel("1754400000.42"));
		expect(callIdForAriChannel("1754400000.42")).not.toBe(legIdForAriChannel("1754400000.42"));
	});

	it("produces a valid entity id", () => {
		expect(isEntityId(callIdForAriChannel("1754400000.42"))).toBe(true);
	});
});

describe("resolveOrganizationId", () => {
	it("reads OPTIMIQ_ORG_ID", () => {
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: ORG })).toBe(ORG);
	});

	it("accepts the long-form alias", () => {
		expect(resolveOrganizationId({ OPTIMIQ_ORGANIZATION_ID: ORG })).toBe(ORG);
	});

	it("prefers the channel variable over the fallback", () => {
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: ORG }, OTHER_ORG)).toBe(ORG);
	});

	it("uses the fallback when no variable is set", () => {
		expect(resolveOrganizationId({}, ORG)).toBe(ORG);
	});

	it("returns undefined rather than guessing when nothing is resolvable", () => {
		expect(resolveOrganizationId({})).toBeUndefined();
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: "" })).toBeUndefined();
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: "   " })).toBeUndefined();
	});

	it("refuses a value that is not an entity id, even when one was supplied", () => {
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: "acme" })).toBeUndefined();
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: "acme" }, "also-not-a-uuid")).toBeUndefined();
	});

	it("falls back when the variable is present but malformed", () => {
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: "acme" }, ORG)).toBe(ORG);
	});

	it("trims surrounding whitespace, which a dialplan Set() readily introduces", () => {
		expect(resolveOrganizationId({ OPTIMIQ_ORG_ID: ` ${ORG} ` })).toBe(ORG);
	});
});
