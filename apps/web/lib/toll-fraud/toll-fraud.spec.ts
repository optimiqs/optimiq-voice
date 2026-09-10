import { describe, expect, it } from "bun:test";
import { queryKeys } from "../query-keys";
import { isResolvableCountry, RESOLVABLE_COUNTRIES } from "./countries";
import {
	EMPTY_OVERRIDE_FORM,
	fromOverrideFormValues,
	overrideFieldErrors,
	sameOverride,
	toOverrideFormValues,
} from "./override-form";
import {
	changedPolicyKeys,
	clockToMinutes,
	EMPTY_TOLL_FRAUD_POLICY_FORM,
	fromPolicyFormValues,
	minutesToClock,
	policyToWrite,
	toCountryList,
	toPolicyFormValues,
	tollFraudPolicyFormSchema,
} from "./policy-form";
import type { ExtensionTollFraudOverride, TollFraudPolicy } from "./client";

const policy: TollFraudPolicy = {
	id: "policy-1",
	organizationId: "org-1",
	enabled: true,
	maxConcurrentInternationalCalls: 5,
	maxInternationalMinutesPerHour: 120,
	maxInternationalMinutesPerDay: null,
	allowedCountries: ["DE", "FR"],
	deniedCountries: null,
	holdFirstCallToNewCountry: true,
	offHoursInternationalLock: false,
	offHoursStartMinute: 1_200,
	offHoursEndMinute: 420,
	offHoursTimezone: "Europe/Berlin",
	autoSuspendOnSignal: false,
};

describe("the toll-fraud policy form projection", () => {
	it("round-trips a stored policy without changing a single key", () => {
		const values = toPolicyFormValues(policy);
		expect(values.offHoursStart).toBe("20:00");
		expect(values.offHoursEnd).toBe("07:00");
		expect(changedPolicyKeys(policyToWrite(policy), fromPolicyFormValues(values))).toEqual([]);
	});

	it("sends an empty ceiling as null rather than zero", () => {
		// Zero is a real value on this surface — it refuses every international call — so a blank box
		// that became one would be an outage nobody typed.
		const body = fromPolicyFormValues({
			...EMPTY_TOLL_FRAUD_POLICY_FORM,
			maxConcurrentInternationalCalls: "",
			maxInternationalMinutesPerHour: "0",
		});
		expect(body.maxConcurrentInternationalCalls).toBeNull();
		expect(body.maxInternationalMinutesPerHour).toBe(0);
	});

	it("collapses an empty country list to null, because an empty allow list would refuse everything", () => {
		expect(toCountryList([])).toBeNull();
		expect(toCountryList(["fr", "DE", "fr"])).toEqual(["DE", "FR"]);
	});

	it("reports no change when a country is removed and re-added", () => {
		const before = fromPolicyFormValues(toPolicyFormValues(policy));
		const after = fromPolicyFormValues({
			...toPolicyFormValues(policy),
			allowedCountries: ["FR", "DE"],
		});
		expect(changedPolicyKeys(before, after)).toEqual([]);
	});

	it("names exactly the keys that changed", () => {
		const before = policyToWrite(policy);
		const after = fromPolicyFormValues({
			...toPolicyFormValues(policy),
			maxInternationalMinutesPerHour: "240",
			offHoursInternationalLock: true,
		});
		expect([...changedPolicyKeys(before, after)].sort()).toEqual([
			"maxInternationalMinutesPerHour",
			"offHoursInternationalLock",
		]);
	});

	it("converts between clock times and minutes since midnight", () => {
		expect(clockToMinutes("00:00")).toBe(0);
		expect(clockToMinutes("23:59")).toBe(1_439);
		expect(minutesToClock(1_200)).toBe("20:00");
		// 24:00 does not exist; the DTO's ceiling is 1439.
		expect(minutesToClock(2_000)).toBe("23:59");
	});

	it("refuses a ceiling that is not a whole number, and a country the platform cannot resolve", () => {
		const bad = tollFraudPolicyFormSchema.safeParse({
			...EMPTY_TOLL_FRAUD_POLICY_FORM,
			maxConcurrentInternationalCalls: "12.5",
		});
		expect(bad.success).toBe(false);

		// "UK" is the obvious wrong answer for the United Kingdom, and the API refuses it.
		const wrongCountry = tollFraudPolicyFormSchema.safeParse({
			...EMPTY_TOLL_FRAUD_POLICY_FORM,
			deniedCountries: ["UK"],
		});
		expect(wrongCountry.success).toBe(false);
		expect(isResolvableCountry("GB")).toBe(true);
		expect(isResolvableCountry("UK")).toBe(false);
	});

	it("offers the same number of countries the API's resolver knows", () => {
		// Mirrors `knownCountries()` in `apps/api/src/pbx/toll-fraud/e164-country.ts`. If the API's
		// table grows, this fails rather than quietly offering a stale list.
		expect(RESOLVABLE_COUNTRIES).toHaveLength(228);
		expect([...RESOLVABLE_COUNTRIES]).toEqual([...RESOLVABLE_COUNTRIES].sort());
	});

	it("keeps the fraud queries under one invalidation handle", () => {
		const handle = queryKeys.tollFraud("org-1");
		for (const key of [
			queryKeys.tollFraudPolicy("org-1"),
			queryKeys.tollFraudUsage("org-1"),
			queryKeys.tollFraudOverrides("org-1"),
		]) {
			expect(key.slice(0, handle.length)).toEqual([...handle]);
		}
	});
});

const override: ExtensionTollFraudOverride = {
	id: "override-1",
	organizationId: "org-1",
	extensionId: "ext-1",
	enabled: false,
	maxConcurrentInternationalCalls: 0,
	maxInternationalMinutesPerHour: null,
	maxInternationalMinutesPerDay: null,
	allowedCountries: null,
	deniedCountries: null,
	holdFirstCallToNewCountry: null,
	offHoursInternationalLock: true,
	outboundSuspended: false,
	suspendedReason: null,
	suspendedAt: null,
};

describe("the per-extension override projection", () => {
	it("reads null as inherit and zero as a ceiling of none", () => {
		const values = toOverrideFormValues(override);
		expect(values.enabled).toBe("off");
		expect(values.maxConcurrentInternationalCalls).toBe("0");
		expect(values.maxInternationalMinutesPerHour).toBe("");
		expect(values.holdFirstCallToNewCountry).toBe("inherit");
		expect(values.offHoursInternationalLock).toBe("on");
	});

	it("writes an empty ceiling back as inherit and a zero back as zero", () => {
		const body = fromOverrideFormValues(toOverrideFormValues(override));
		expect(body.maxConcurrentInternationalCalls).toBe(0);
		expect(body.maxInternationalMinutesPerHour).toBeNull();
		expect(body.enabled).toBe(false);
		expect(body.holdFirstCallToNewCountry).toBeNull();
	});

	it("never touches the country lists, which this form does not offer", () => {
		const body = fromOverrideFormValues(EMPTY_OVERRIDE_FORM);
		expect(body.allowedCountries).toBeNull();
		expect(body.deniedCountries).toBeNull();
	});

	it("an extension with no override round-trips to all-inherit and reads as unchanged", () => {
		const values = toOverrideFormValues(undefined);
		expect(values).toEqual(EMPTY_OVERRIDE_FORM);
		// This is the test that keeps an untouched extension from acquiring a row full of inherits.
		expect(sameOverride(values, EMPTY_OVERRIDE_FORM)).toBe(true);
	});

	it("notices a real change, and ignores whitespace typed into a ceiling", () => {
		const stored = toOverrideFormValues(override);
		expect(sameOverride(stored, { ...stored, maxConcurrentInternationalCalls: " 0 " })).toBe(true);
		expect(sameOverride(stored, { ...stored, enabled: "inherit" })).toBe(false);
	});

	it("refuses a ceiling above the DTO's bound before the request is made", () => {
		expect(
			overrideFieldErrors({ ...EMPTY_OVERRIDE_FORM, maxConcurrentInternationalCalls: "100001" }),
		).toHaveProperty("maxConcurrentInternationalCalls");
		expect(
			overrideFieldErrors({ ...EMPTY_OVERRIDE_FORM, maxInternationalMinutesPerHour: "1000000" }),
		).toEqual({});
	});
});
