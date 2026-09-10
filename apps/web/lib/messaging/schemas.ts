import { z } from "zod";
import { BRAND_ENTITY_TYPES, NUMBER_CLASSES } from "./contracts";
import { timeToMinutes } from "./format";

/**
 * What this app refuses to SEND, as opposed to what the API refuses to accept.
 *
 * Every body under `/api/v1/messaging` is strict, so a request carrying an unknown key is a 400
 * and a request missing a required one is a 400 with the field named. These schemas exist to catch
 * the second class before the round trip, and — for the registration forms — to be the one place
 * the carriers' rules are written down in a form a test can read.
 *
 * They are deliberately NOT a mirror of the server's DTOs. Where the server is the authority (what
 * a valid vertical is, whether a website resolves) the client stays quiet and lets the 400 land on
 * the field through `lib/forms/server-errors.ts`. Where the rule is a SHAPE the user can see and
 * fix without a round trip — a country code that is not two letters — checking here turns a
 * rejected submission into a red line under the control that caused it.
 */

const trimmed = z.string().trim();
const required = (label: string) => trimmed.min(1, `${label} is required`);

/** An https URL. Carriers reject plain http for a policy link, so this does too, in advance. */
const httpsUrl = (label: string) =>
	trimmed
		.min(1, `${label} is required`)
		.refine(
			(value) => /^https:\/\/\S+\.\S+/u.test(value),
			`${label} must be a full https:// address`,
		);

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

export const enableMessagingSchema = z.object({
	phoneNumberId: required("A phone number"),
	numberClass: z.enum(NUMBER_CLASSES),
});
export type EnableMessagingForm = z.infer<typeof enableMessagingSchema>;

/**
 * Retention, as the form holds it: a string, because an empty `<input type="number">` is `""` and
 * not `undefined`. Empty means "the organization's default", which the API expresses as `null` —
 * so the emptiness is preserved here and translated at the call site rather than coerced to 0.
 */
export const retentionDaysSchema = trimmed.refine((value) => {
	if (value.length === 0) {
		return true;
	}
	const days = Number(value);
	return Number.isInteger(days) && days >= 1 && days <= 3650;
}, "Retention is a whole number of days between 1 and 3650, or empty for the organization default");

// ---------------------------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------------------------

/**
 * The 10DLC brand.
 *
 * The EIN rule is the only conditional one and it is the registry's, not ours: a sole proprietor
 * has no employer identification number, and every other entity type must give one. Enforcing it
 * here means the person who picked SOLE_PROPRIETOR is never asked for a number that does not
 * exist, and the person who picked PRIVATE_PROFIT is not told about it by a carrier three days
 * later.
 */
export const brandSchema = z
	.object({
		displayName: required("A display name"),
		companyName: required("A company name"),
		entityType: z.enum(BRAND_ENTITY_TYPES),
		ein: trimmed,
		vertical: required("A vertical"),
		contactEmail: z.email("Enter the contact email address"),
		contactPhone: required("A contact phone number"),
		website: trimmed,
		street: required("A street address"),
		city: required("A city"),
		state: required("A state or province"),
		postalCode: required("A postal code"),
		country: trimmed
			.length(2, "Use the two-letter country code — US, not USA")
			.regex(/^[A-Za-z]{2}$/u, "Use the two-letter country code — US, not USA"),
	})
	.refine((value) => value.entityType === "SOLE_PROPRIETOR" || value.ein.length > 0, {
		message: "An EIN is required for every entity type except a sole proprietor",
		path: ["ein"],
	});
export type BrandForm = z.infer<typeof brandSchema>;

export const brandOtpSchema = z.object({
	pin: trimmed
		.min(4, "The PIN is the code in the text message")
		.regex(/^\d{4,10}$/u, "The PIN is 4 to 10 digits"),
});
export type BrandOtpForm = z.infer<typeof brandOtpSchema>;

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

/** Between two and five, which is the registry's bound and not a UI preference. */
export const CAMPAIGN_SAMPLE_MIN = 2;
export const CAMPAIGN_SAMPLE_MAX = 5;

/**
 * A comma-separated keyword list, as the form holds it.
 *
 * Split here rather than in the component so "STOP, stopall , quit" and "STOP,stopall,quit" are
 * the same request. Upper-cased because that is how every carrier stores and matches them, and a
 * list that round-trips as `stop` would render differently after a save than it did before one.
 */
export function parseKeywords(value: string): readonly string[] {
	return [
		...new Set(
			value
				.split(",")
				.map((entry) => entry.trim().toUpperCase())
				.filter((entry) => entry.length > 0),
		),
	];
}

export const campaignSchema = z
	.object({
		name: required("A campaign name"),
		useCase: required("A use case"),
		description: trimmed.min(20, "Describe the campaign in at least 20 characters"),
		sampleMessages: z
			.array(trimmed)
			.transform((entries) => entries.filter((entry) => entry.length > 0))
			.refine(
				(entries) => entries.length >= CAMPAIGN_SAMPLE_MIN && entries.length <= CAMPAIGN_SAMPLE_MAX,
				`Give between ${String(CAMPAIGN_SAMPLE_MIN)} and ${String(CAMPAIGN_SAMPLE_MAX)} sample messages`,
			),
		messageFlow: trimmed.min(20, "Describe how somebody opts in, in at least 20 characters"),
		helpMessage: required("A HELP reply"),
		optOutMessage: required("A STOP reply"),
		optInKeywords: trimmed,
		optOutKeywords: required("At least one opt-out keyword — STOP is the usual one"),
		helpKeywords: trimmed,
		embeddedLink: z.boolean(),
		ageGated: z.boolean(),
		quietHoursEnabled: z.boolean(),
		quietHoursStart: trimmed,
		quietHoursEnd: trimmed,
		quietHoursTimeZone: trimmed,
	})
	.superRefine((value, ctx) => {
		if (!value.quietHoursEnabled) {
			return;
		}
		if (timeToMinutes(value.quietHoursStart) === null) {
			ctx.addIssue({
				code: "custom",
				path: ["quietHoursStart"],
				message: "Enter a start time as HH:MM",
			});
		}
		if (timeToMinutes(value.quietHoursEnd) === null) {
			ctx.addIssue({
				code: "custom",
				path: ["quietHoursEnd"],
				message: "Enter an end time as HH:MM",
			});
		}
		/**
		 * An IANA zone name, checked for its SHAPE only. `Intl` knows the real list and the browser
		 * that renders this is the one that will read it back, so `America/New_York` passes and
		 * `EST` — a fixed offset that ignores daylight saving, which is precisely the bug quiet hours
		 * must not have — does not.
		 */
		if (!/^[A-Za-z]+\/[A-Za-z_+\-0-9]+(\/[A-Za-z_+\-0-9]+)?$/u.test(value.quietHoursTimeZone)) {
			ctx.addIssue({
				code: "custom",
				path: ["quietHoursTimeZone"],
				message: "Use an IANA time zone such as America/New_York — not an abbreviation like EST",
			});
		}
	});
export type CampaignForm = z.infer<typeof campaignSchema>;

// ---------------------------------------------------------------------------------------------
// Toll-free verification
// ---------------------------------------------------------------------------------------------

/**
 * Why the three BRN fields are not optional, in one sentence, shown on the form itself.
 *
 * Exported rather than inlined so the copy and the validation cannot drift: the same constant that
 * explains the requirement sits beside the rule that enforces it.
 */
export const BRN_REQUIREMENT_NOTE =
	"Required by the carriers for every submission since 17 February 2026.";

/**
 * The business registration country.
 *
 * ISO 3166-1 alpha-2, and the two failures are told apart deliberately: an EMPTY value is a field
 * somebody has not filled in, and `USA` or `united states` is a field somebody filled in wrongly.
 * Same red line, different sentence, because the second needs to say what the right shape is.
 */
export const businessRegistrationCountrySchema = trimmed
	.min(1, "The business registration country is required")
	.refine(
		(value) => /^[A-Za-z]{2}$/u.test(value),
		"Use the two-letter ISO country code — US, not USA",
	);

export const tollFreeVerificationSchema = z.object({
	messagingNumberId: required("A toll-free number"),
	businessName: required("The business name"),
	businessWebsite: httpsUrl("The business website"),
	businessStreet: required("A street address"),
	businessCity: required("A city"),
	businessState: required("A state or province"),
	businessPostalCode: required("A postal code"),
	businessCountry: trimmed.regex(/^[A-Za-z]{2}$/u, "Use the two-letter country code — US, not USA"),
	businessContactFirstName: required("A contact first name"),
	businessContactLastName: required("A contact last name"),
	businessContactEmail: z.email("Enter the contact email address"),
	businessContactPhone: required("A contact phone number"),
	businessRegistrationNumber: required("The business registration number"),
	businessRegistrationType: required("The business registration type"),
	businessRegistrationCountry: businessRegistrationCountrySchema,
	privacyPolicyUrl: httpsUrl("A privacy policy URL"),
	termsAndConditionsUrl: httpsUrl("A terms and conditions URL"),
	useCase: required("A use case"),
	useCaseSummary: trimmed.min(20, "Summarise the use case in at least 20 characters"),
	productionMessageContent: trimmed.min(
		10,
		"Give the real message content you intend to send, at least 10 characters",
	),
	optInWorkflow: trimmed.min(20, "Describe the opt-in workflow in at least 20 characters"),
	optInWorkflowImageUrls: trimmed,
	messageVolume: required("An estimated monthly message volume"),
});
export type TollFreeVerificationForm = z.infer<typeof tollFreeVerificationSchema>;

/** One URL per line, in the order they were typed. Blank lines are not URLs and are dropped. */
export function parseUrlList(value: string): readonly string[] {
	return value
		.split(/[\n,]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------------------------

export const manualOptOutSchema = z.object({
	messagingNumberId: required("A messaging number"),
	remoteE164: trimmed.regex(
		/^\+\d{7,15}$/u,
		"Enter the number in E.164 form, starting with + and the country code",
	),
});
export type ManualOptOutForm = z.infer<typeof manualOptOutSchema>;
