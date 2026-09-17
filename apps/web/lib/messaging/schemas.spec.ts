import { describe, expect, it } from "bun:test";
import {
	BRN_REQUIREMENT_NOTE,
	brandSchema,
	businessRegistrationCountrySchema,
	campaignSchema,
	manualOptOutSchema,
	parseKeywords,
	parseUrlList,
	tollFreeVerificationSchema,
} from "./schemas";

function tollFreeForm(overrides: Record<string, unknown> = {}) {
	return {
		messagingNumberId: "mn-1",
		businessName: "Northwind Trading",
		businessWebsite: "https://northwind.example",
		businessStreet: "1 Harbour Way",
		businessCity: "Seattle",
		businessState: "WA",
		businessPostalCode: "98101",
		businessCountry: "US",
		businessContactFirstName: "Dana",
		businessContactLastName: "Ruiz",
		businessContactEmail: "dana@northwind.example",
		businessContactPhone: "+12065550100",
		businessRegistrationNumber: "91-1234567",
		businessRegistrationType: "EIN",
		businessRegistrationCountry: "US",
		privacyPolicyUrl: "https://northwind.example/privacy",
		termsAndConditionsUrl: "https://northwind.example/terms",
		useCase: "customer-care",
		useCaseSummary: "Appointment reminders and replies to customer questions.",
		productionMessageContent: "Your appointment is at 3pm. Reply STOP to opt out.",
		optInWorkflow: "Customers tick a box on the booking form and confirm by replying YES.",
		optInWorkflowImageUrls: "https://northwind.example/optin.png",
		messageVolume: "10000",
		...overrides,
	};
}

/**
 * The BRN trio is what the whole toll-free form hangs on: the carriers made it mandatory for every
 * submission from 17 February 2026, and a submission missing it is rejected days later with no
 * explanation an operator can act on. So the refusal happens here, on the control.
 */
describe("the toll-free business registration number", () => {
	it("accepts a complete submission", () => {
		expect(tollFreeVerificationSchema.safeParse(tollFreeForm()).success).toBe(true);
	});

	it("refuses a submission with no registration number", () => {
		const result = tollFreeVerificationSchema.safeParse(
			tollFreeForm({ businessRegistrationNumber: "" }),
		);

		expect(result.success).toBe(false);
		expect(
			result.error?.issues.some((issue) => issue.path[0] === "businessRegistrationNumber"),
		).toBe(true);
	});

	it("refuses a submission with no registration type", () => {
		const result = tollFreeVerificationSchema.safeParse(
			tollFreeForm({ businessRegistrationType: "  " }),
		);

		expect(result.success).toBe(false);
		expect(result.error?.issues.some((issue) => issue.path[0] === "businessRegistrationType")).toBe(
			true,
		);
	});

	/**
	 * Missing and malformed are told apart on purpose: one is a field nobody filled in, the other
	 * is a field somebody filled in wrongly, and only the second needs to be told what the right
	 * shape is.
	 */
	it("refuses a missing registration country with a different message than a malformed one", () => {
		const missing = businessRegistrationCountrySchema.safeParse("");
		const malformed = businessRegistrationCountrySchema.safeParse("USA");

		expect(missing.success).toBe(false);
		expect(malformed.success).toBe(false);
		expect(missing.error?.issues[0]?.message).not.toBe(malformed.error?.issues[0]?.message);
		expect(malformed.error?.issues[0]?.message).toContain("US, not USA");
	});

	it("refuses every malformed country code the field invites", () => {
		for (const value of ["USA", "u", "United States", "U1", " U S "]) {
			expect(businessRegistrationCountrySchema.safeParse(value).success).toBe(false);
		}
	});

	/** Case is the user's business; the value is two letters either way. */
	it("accepts a two-letter code in any case", () => {
		expect(businessRegistrationCountrySchema.safeParse("us").success).toBe(true);
		expect(businessRegistrationCountrySchema.safeParse(" CA ").success).toBe(true);
	});

	it("blocks the whole submission when only the country is malformed", () => {
		expect(
			tollFreeVerificationSchema.safeParse(tollFreeForm({ businessRegistrationCountry: "USA" }))
				.success,
		).toBe(false);
	});

	/** The two policy links are as required as the BRN, and must be real https addresses. */
	it("requires both policy URLs", () => {
		expect(
			tollFreeVerificationSchema.safeParse(tollFreeForm({ privacyPolicyUrl: "" })).success,
		).toBe(false);
		expect(
			tollFreeVerificationSchema.safeParse(tollFreeForm({ termsAndConditionsUrl: "example.com" }))
				.success,
		).toBe(false);
	});

	it("names the date the requirement started, once, where the form can show it", () => {
		expect(BRN_REQUIREMENT_NOTE).toContain("17 February 2026");
	});
});

describe("brandSchema", () => {
	const brand = (overrides: Record<string, unknown> = {}) => ({
		displayName: "Northwind",
		companyName: "Northwind Trading LLC",
		entityType: "PRIVATE_PROFIT",
		ein: "91-1234567",
		vertical: "RETAIL",
		contactEmail: "dana@northwind.example",
		contactPhone: "+12065550100",
		website: "https://northwind.example",
		street: "1 Harbour Way",
		city: "Seattle",
		state: "WA",
		postalCode: "98101",
		country: "US",
		...overrides,
	});

	it("accepts a complete brand", () => {
		expect(brandSchema.safeParse(brand()).success).toBe(true);
	});

	/** A sole proprietor has no EIN, and must never be asked for one. */
	it("requires an EIN for every entity type except a sole proprietor", () => {
		expect(brandSchema.safeParse(brand({ ein: "" })).success).toBe(false);
		expect(brandSchema.safeParse(brand({ entityType: "SOLE_PROPRIETOR", ein: "" })).success).toBe(
			true,
		);
	});
});

describe("campaignSchema", () => {
	const campaign = (overrides: Record<string, unknown> = {}) => ({
		name: "Support replies",
		useCase: "CUSTOMER_CARE",
		description: "Two-way replies to inbound customer questions about orders.",
		sampleMessages: ["Your order shipped.", "Reply STOP to opt out."],
		messageFlow: "Customers tick a box on the booking form and confirm by replying YES.",
		helpMessage: "Reply HELP for help.",
		optOutMessage: "You have been unsubscribed.",
		optInKeywords: "START, YES",
		optOutKeywords: "STOP",
		helpKeywords: "HELP",
		embeddedLink: false,
		ageGated: false,
		quietHoursEnabled: false,
		quietHoursStart: "",
		quietHoursEnd: "",
		quietHoursTimeZone: "",
		...overrides,
	});

	it("accepts a campaign with no quiet hours at all", () => {
		expect(campaignSchema.safeParse(campaign()).success).toBe(true);
	});

	it("holds the registry's two-to-five bound on sample messages", () => {
		expect(campaignSchema.safeParse(campaign({ sampleMessages: ["only one"] })).success).toBe(
			false,
		);
		expect(
			campaignSchema.safeParse(campaign({ sampleMessages: ["a", "b", "c", "d", "e", "f"] }))
				.success,
		).toBe(false);
	});

	/** Empty rows in the sample list are blank inputs, not messages. */
	it("ignores blank sample rows when counting", () => {
		expect(
			campaignSchema.safeParse(campaign({ sampleMessages: ["one", "two", "", "  "] })).success,
		).toBe(true);
	});

	it("checks the quiet-hours fields only once quiet hours are on", () => {
		expect(
			campaignSchema.safeParse(
				campaign({
					quietHoursEnabled: true,
					quietHoursStart: "21:00",
					quietHoursEnd: "08:00",
					quietHoursTimeZone: "America/New_York",
				}),
			).success,
		).toBe(true);
		expect(
			campaignSchema.safeParse(
				campaign({
					quietHoursEnabled: true,
					quietHoursStart: "9pm",
					quietHoursEnd: "08:00",
					quietHoursTimeZone: "America/New_York",
				}),
			).success,
		).toBe(false);
	});

	/**
	 * `EST` is a fixed offset that ignores daylight saving, which is precisely the bug quiet hours
	 * must not have — a window that holds still in January and moves in July.
	 */
	it("refuses a time-zone abbreviation in place of an IANA zone", () => {
		expect(
			campaignSchema.safeParse(
				campaign({
					quietHoursEnabled: true,
					quietHoursStart: "21:00",
					quietHoursEnd: "08:00",
					quietHoursTimeZone: "EST",
				}),
			).success,
		).toBe(false);
	});
});

describe("parseKeywords", () => {
	it("normalises spacing, case and duplicates so one list has one meaning", () => {
		expect(parseKeywords("STOP, stopall , quit,STOP")).toEqual(["STOP", "STOPALL", "QUIT"]);
	});

	it("has an answer for an empty field", () => {
		expect(parseKeywords("  ")).toEqual([]);
	});
});

describe("parseUrlList", () => {
	it("takes one URL per line and drops the blanks", () => {
		expect(parseUrlList("https://a.example/1\n\nhttps://a.example/2\n")).toEqual([
			"https://a.example/1",
			"https://a.example/2",
		]);
	});
});

describe("manualOptOutSchema", () => {
	it("insists on E.164, because the suppression list is matched exactly", () => {
		expect(
			manualOptOutSchema.safeParse({ messagingNumberId: "n1", remoteE164: "+15551234567" }).success,
		).toBe(true);
		expect(
			manualOptOutSchema.safeParse({ messagingNumberId: "n1", remoteE164: "(555) 123-4567" })
				.success,
		).toBe(false);
	});
});
