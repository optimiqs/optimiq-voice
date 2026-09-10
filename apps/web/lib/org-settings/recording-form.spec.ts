import { describe, expect, it } from "bun:test";
import { DEFAULT_ALL_PARTY_REGIONS } from "./client";
import {
	EMPTY_RECORDING_FORM,
	formatRegionList,
	fromRecordingFormValues,
	MAX_ALL_PARTY_REGIONS,
	parseRegionList,
	recordingSettingsFormSchema,
	toRecordingFormValues,
} from "./recording-form";
import type { RecordingSettings } from "./client";

/**
 * The projection between the `recordings` category and the form that edits it.
 *
 * The interesting cases are the ones where a control's empty state and a setting's default are not
 * the same fact: `0` is a real retention window meaning "for ever", `""` in the prompt selector has
 * to reach the cascade as `null`, and the two consent digits may not be the same key.
 */

const LOADED: RecordingSettings = {
	retentionDays: 30,
	voicemailRetentionDays: 14,
	consentPolicy: "announce",
	consentPromptId: "8f14e45f-ea3a-4a9b-8e2b-1f9d4a0f1c2d",
	consentAcceptDigit: "1",
	consentDeclineDigit: "2",
	allPartyRegions: ["US-CA", "EU"],
	autoPauseOnDtmf: true,
};

describe("toRecordingFormValues", () => {
	it("renders both windows as strings, including a zero that means for ever", () => {
		expect(toRecordingFormValues(LOADED).retentionDays).toBe("30");
		expect(
			toRecordingFormValues({ ...LOADED, retentionDays: 0, voicemailRetentionDays: 0 }),
		).toMatchObject({ retentionDays: "0", voicemailRetentionDays: "0" });
	});

	it("renders an unset prompt as a blank selector rather than as the string null", () => {
		expect(toRecordingFormValues({ ...LOADED, consentPromptId: null }).consentPromptId).toBe("");
	});

	it("seeds the empty form with the catalogue's own defaults", () => {
		expect(EMPTY_RECORDING_FORM.consentPolicy).toBe("none");
		expect(EMPTY_RECORDING_FORM.consentAcceptDigit).toBe("1");
		expect(EMPTY_RECORDING_FORM.consentDeclineDigit).toBe("2");
		expect(parseRegionList(EMPTY_RECORDING_FORM.allPartyRegions)).toEqual([
			...DEFAULT_ALL_PARTY_REGIONS,
		]);
	});
});

describe("recordingSettingsFormSchema", () => {
	const base = toRecordingFormValues(LOADED);

	it("accepts zero and refuses a blank window, because blank is not a policy", () => {
		expect(recordingSettingsFormSchema.safeParse({ ...base, retentionDays: "0" }).success).toBe(
			true,
		);
		expect(recordingSettingsFormSchema.safeParse({ ...base, retentionDays: "" }).success).toBe(
			false,
		);
		expect(recordingSettingsFormSchema.safeParse({ ...base, retentionDays: "1.5" }).success).toBe(
			false,
		);
		expect(
			recordingSettingsFormSchema.safeParse({ ...base, voicemailRetentionDays: "3651" }).success,
		).toBe(false);
	});

	it("holds each consent digit to a single key a handset can send", () => {
		expect(
			recordingSettingsFormSchema.safeParse({ ...base, consentAcceptDigit: "#" }).success,
		).toBe(true);
		expect(
			recordingSettingsFormSchema.safeParse({ ...base, consentAcceptDigit: "12" }).success,
		).toBe(false);
		expect(
			recordingSettingsFormSchema.safeParse({ ...base, consentAcceptDigit: "A" }).success,
		).toBe(false);
	});

	/**
	 * The engine tests the pressed digit against accept first, so one digit for both would silently
	 * mean everybody consents — a caller who believed they declined would be recorded, which is the
	 * one outcome the feature exists to prevent.
	 */
	it("refuses the same digit for accept and decline, on the decline field", () => {
		const result = recordingSettingsFormSchema.safeParse({
			...base,
			consentAcceptDigit: "1",
			consentDeclineDigit: "1",
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["consentDeclineDigit"]);
	});

	it("refuses more regions than the catalogue stores", () => {
		const tooMany = Array.from({ length: MAX_ALL_PARTY_REGIONS + 1 }, (_, i) => `X${i}`).join(", ");
		expect(
			recordingSettingsFormSchema.safeParse({ ...base, allPartyRegions: tooMany }).success,
		).toBe(false);
	});
});

describe("fromRecordingFormValues", () => {
	function parse(values: unknown) {
		return fromRecordingFormValues(recordingSettingsFormSchema.parse(values));
	}

	it("sends a cleared prompt as null, so the tenant stops hearing the old recording", () => {
		expect(parse({ ...toRecordingFormValues(LOADED), consentPromptId: "" }).consentPromptId).toBe(
			null,
		);
	});

	it("round-trips the settings it was given", () => {
		expect(parse(toRecordingFormValues(LOADED))).toEqual(LOADED);
	});
});

describe("parseRegionList", () => {
	/**
	 * Commas and newlines both separate, because both are how a person pastes a list — and codes are
	 * upper cased because the engine compares them with `===` against `US-CA`, so `us-ca` would be a
	 * region that matches nothing and quietly weakens the posture.
	 */
	it("splits on commas and newlines, upper cases and de-duplicates", () => {
		expect(parseRegionList("us-ca, EU\nUS-WA\nus-ca")).toEqual(["US-CA", "EU", "US-WA"]);
	});

	it("reads an empty box as an empty list rather than as one blank region", () => {
		expect(parseRegionList("")).toEqual([]);
		expect(parseRegionList(" ,\n ")).toEqual([]);
	});

	it("round-trips through the formatter", () => {
		expect(parseRegionList(formatRegionList(["US-CA", "EU"]))).toEqual(["US-CA", "EU"]);
	});
});
