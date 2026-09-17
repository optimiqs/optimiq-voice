import { z } from "zod";
import { RECORDING_CONSENT_POLICIES } from "../pbx/contracts";
import {
	DEFAULT_ALL_PARTY_REGIONS,
	DTMF_DIGIT_PATTERN,
	RECORDING_RETENTION_MAX_DAYS,
} from "./client";
import type { RecordingConsentPolicy } from "../pbx/contracts";
import type { RecordingSettings } from "./client";

/**
 * The `recordings` settings category, in the shape a form can hold.
 *
 * Split out of the page for the reason `routing-form.ts` is: the projection between the cascade's
 * values and a form's controls is where the mistakes live. Two of the eight are numbers whose `0`
 * means "for ever" rather than "none", one is nullable and has to clear to `null` rather than to
 * `""`, and one is a list of regions edited as free text. Each of those is a pure function with a
 * spec rather than a line of JSX.
 *
 * ## `0` is a value here, not an empty box
 *
 * Both retention windows use the platform's own `CDR_RECORDING_RETENTION_DAYS` vocabulary: `0`
 * keeps things indefinitely. So neither control is allowed to be blank — a blank box would be a
 * third spelling of "unset" that the cascade has no way to store, and the form would be inventing
 * a policy the server never agreed to.
 */

/** The catalogue's own bound on the region list. */
export const MAX_ALL_PARTY_REGIONS = 64;

export interface RecordingSettingsFormValues {
	retentionDays: string;
	voicemailRetentionDays: string;
	consentPolicy: RecordingConsentPolicy;
	/** A prompt row id, or `""` for "use the built-in announcement". */
	consentPromptId: string;
	consentAcceptDigit: string;
	consentDeclineDigit: string;
	/** Free text, one region per line or comma-separated — see {@link parseRegionList}. */
	allPartyRegions: string;
	autoPauseOnDtmf: boolean;
}

function retentionField(label: string) {
	return z
		.string()
		.trim()
		.min(1, `${label} — enter 0 to keep them indefinitely`)
		.transform((value) => Number(value))
		.refine((value) => Number.isInteger(value), "Whole days only")
		.refine(
			(value) => value >= 0 && value <= RECORDING_RETENTION_MAX_DAYS,
			`Must be between 0 and ${RECORDING_RETENTION_MAX_DAYS}`,
		);
}

/**
 * One DTMF digit, spelled exactly as the catalogue spells it.
 *
 * `0-9`, `*` and `#` and nothing else — not `A`-`D`, which the queue exit key allows: the two
 * consent digits are read off a prompt a person hears and no handset offers those four keys.
 */
const dtmfDigit = z.string().trim().regex(DTMF_DIGIT_PATTERN, "One digit: 0-9, * or #");

export const recordingSettingsFormSchema = z
	.object({
		retentionDays: retentionField("Required"),
		voicemailRetentionDays: retentionField("Required"),
		consentPolicy: z.enum(RECORDING_CONSENT_POLICIES),
		consentPromptId: z
			.string()
			.trim()
			.refine((value) => value === "" || z.uuid().safeParse(value).success, {
				message: "Pick a prompt from the list",
			}),
		consentAcceptDigit: dtmfDigit,
		consentDeclineDigit: dtmfDigit,
		allPartyRegions: z
			.string()
			.refine((value) => parseRegionList(value).length <= MAX_ALL_PARTY_REGIONS, {
				message: `At most ${MAX_ALL_PARTY_REGIONS} regions`,
			})
			.refine(
				(value) => parseRegionList(value).every((entry) => entry.length >= 2 && entry.length <= 8),
				{ message: "Each region is an ISO code of 2 to 8 characters, e.g. US-CA or EU" },
			),
		autoPauseOnDtmf: z.boolean(),
	})
	/**
	 * The two digits may not be the same one.
	 *
	 * The engine compares the pressed digit against accept first, so a shared digit would silently
	 * mean "everybody consents" — a caller who believed they declined would be recorded, which is
	 * the one outcome this whole feature exists to prevent. The message lands on the decline field
	 * because that is the one the reader just typed.
	 */
	.refine((value) => value.consentAcceptDigit !== value.consentDeclineDigit, {
		path: ["consentDeclineDigit"],
		message: "The accept and decline digits must be different",
	});

/**
 * Seed values for the first render, before the category query resolves.
 *
 * They repeat the catalogue's defaults, which is what the API returns for a tenant with no rows.
 * Binding a switch to `undefined` in the meantime makes it an uncontrolled input that React then
 * complains about the moment the data arrives.
 */
export const EMPTY_RECORDING_FORM: RecordingSettingsFormValues = {
	retentionDays: "0",
	voicemailRetentionDays: "0",
	consentPolicy: "none",
	consentPromptId: "",
	consentAcceptDigit: "1",
	consentDeclineDigit: "2",
	allPartyRegions: formatRegionList(DEFAULT_ALL_PARTY_REGIONS),
	autoPauseOnDtmf: false,
};

export function toRecordingFormValues(settings: RecordingSettings): RecordingSettingsFormValues {
	return {
		retentionDays: String(settings.retentionDays),
		voicemailRetentionDays: String(settings.voicemailRetentionDays),
		consentPolicy: settings.consentPolicy,
		consentPromptId: settings.consentPromptId ?? "",
		consentAcceptDigit: settings.consentAcceptDigit,
		consentDeclineDigit: settings.consentDeclineDigit,
		allPartyRegions: formatRegionList(settings.allPartyRegions),
		autoPauseOnDtmf: settings.autoPauseOnDtmf,
	};
}

/**
 * The form's values as the eight catalogued settings, ready to be diffed against what was loaded.
 *
 * Every key is present — `changedSettings` is what decides which of them reach the PATCH, and it
 * can only do that if it is handed the whole picture.
 */
export function fromRecordingFormValues(
	values: z.output<typeof recordingSettingsFormSchema>,
): RecordingSettings {
	const promptId = values.consentPromptId.trim();
	return {
		retentionDays: values.retentionDays,
		voicemailRetentionDays: values.voicemailRetentionDays,
		consentPolicy: values.consentPolicy,
		// `""` is not a prompt id and the column is nullable: a cleared selector has to reach the
		// cascade as `null` or the tenant keeps hearing a recording they just removed.
		consentPromptId: promptId.length === 0 ? null : promptId,
		consentAcceptDigit: values.consentAcceptDigit,
		consentDeclineDigit: values.consentDeclineDigit,
		allPartyRegions: parseRegionList(values.allPartyRegions),
		autoPauseOnDtmf: values.autoPauseOnDtmf,
	};
}

/**
 * A list of region codes out of one text box.
 *
 * Commas AND newlines both separate, because both are how a person pastes a list. Codes are upper
 * cased — the engine compares them with `===` against `US-CA`, so `us-ca` would be a region that
 * matches nothing and quietly weakens the posture — and duplicates are collapsed, since the engine
 * treats the list as a set and a repeat would only ever show up as a spurious diff.
 */
export function parseRegionList(value: string): string[] {
	const entries = value
		.split(/[\n,]/u)
		.map((entry) => entry.trim().toUpperCase())
		.filter((entry) => entry.length > 0);
	return [...new Set(entries)];
}

export function formatRegionList(entries: readonly string[]): string {
	return entries.join(", ");
}
