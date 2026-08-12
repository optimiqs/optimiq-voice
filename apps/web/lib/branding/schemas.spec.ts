import { describe, expect, it } from "bun:test";
import { DEFAULT_BRANDING, toBranding, type Branding } from "./contracts";
import { brandingFormSchema, brandingToForm, formToBrandingPatch } from "./schemas";

/**
 * The branding form ↔ wire conversion, matched to `apps/api`'s `updateBrandingDto` / `EffectiveBranding`.
 *
 * The invariants worth pinning: an empty input means "unset" (`null`), EXCEPT `customDomain`, which
 * the resolved read never returns and so must be OMITTED when blank rather than cleared; and a blank
 * product name is rejected outright.
 */

const RESOLVED: Branding = {
	productName: "Acme Voice",
	logoObjectKey: "branding/acme.svg",
	primaryColor: "#2f6fed",
	accentColor: "#e11d48",
	supportEmail: "help@acme.example",
	defaultLanguage: "en-GB",
	customDomain: null,
};

describe("brandingToForm / formToBrandingPatch", () => {
	it("seeds the form from a resolved brand", () => {
		const form = brandingToForm(RESOLVED);
		expect(form.productName).toBe("Acme Voice");
		expect(form.logoObjectKey).toBe("branding/acme.svg");
		expect(form.primaryColor).toBe("#2f6fed");
		expect(form.defaultLanguage).toBe("en-GB");
		expect(form.customDomain).toBe("");
	});

	it("maps empty strings back to null and defaults the language", () => {
		const patch = formToBrandingPatch({
			productName: "Acme Voice",
			logoObjectKey: "",
			primaryColor: "",
			accentColor: "  ",
			supportEmail: "",
			customDomain: "",
			defaultLanguage: "",
		});
		expect(patch).toEqual({
			productName: "Acme Voice",
			logoObjectKey: null,
			primaryColor: null,
			accentColor: null,
			supportEmail: null,
			defaultLanguage: "en",
		});
	});

	it("omits customDomain when blank so a save never clears the domain it never showed", () => {
		const patch = formToBrandingPatch(brandingToForm(RESOLVED));
		expect("customDomain" in patch).toBe(false);
	});

	it("includes customDomain when the user entered one", () => {
		const patch = formToBrandingPatch({
			...brandingToForm(RESOLVED),
			customDomain: "voice.acme.example",
		});
		expect(patch.customDomain).toBe("voice.acme.example");
	});
});

describe("brandingFormSchema", () => {
	it("accepts hex colours, an object key, an email, a hostname, a language and empties", () => {
		const result = brandingFormSchema.safeParse({
			productName: "Acme Voice",
			logoObjectKey: "branding/acme.svg",
			primaryColor: "#2f6fed",
			accentColor: "",
			supportEmail: "help@acme.example",
			customDomain: "voice.acme.example",
			defaultLanguage: "en-GB",
		});
		expect(result.success).toBe(true);
	});

	it("accepts a three-digit hex, matching the API", () => {
		expect(brandingFormSchema.safeParse({ ...validForm(), primaryColor: "#abc" }).success).toBe(
			true,
		);
	});

	it("rejects a non-hex colour, a bad email, a bad domain and a bad language", () => {
		expect(brandingFormSchema.safeParse({ ...validForm(), primaryColor: "blue" }).success).toBe(
			false,
		);
		expect(brandingFormSchema.safeParse({ ...validForm(), supportEmail: "nope" }).success).toBe(
			false,
		);
		expect(
			brandingFormSchema.safeParse({ ...validForm(), customDomain: "not a host" }).success,
		).toBe(false);
		expect(
			brandingFormSchema.safeParse({ ...validForm(), defaultLanguage: "english" }).success,
		).toBe(false);
	});

	it("requires a product name", () => {
		expect(brandingFormSchema.safeParse({ ...validForm(), productName: "  " }).success).toBe(false);
	});
});

describe("toBranding", () => {
	it("degrades a malformed payload to the default brand", () => {
		expect(toBranding(null)).toEqual(DEFAULT_BRANDING);
		expect(toBranding("nonsense")).toEqual(DEFAULT_BRANDING);
	});

	it("keeps provided fields, nulls the blanks and defaults the language", () => {
		expect(toBranding({ productName: "Acme", primaryColor: "#2f6fed", logoObjectKey: "" })).toEqual(
			{
				productName: "Acme",
				logoObjectKey: null,
				primaryColor: "#2f6fed",
				accentColor: null,
				supportEmail: null,
				defaultLanguage: "en",
				customDomain: null,
			},
		);
	});
});

function validForm() {
	return {
		productName: "Acme Voice",
		logoObjectKey: "",
		primaryColor: "#2f6fed",
		accentColor: "",
		supportEmail: "",
		customDomain: "",
		defaultLanguage: "",
	};
}
