import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createTelnyxClient } from "../client";
import { type FakeTelnyxServer, startFakeTelnyxServer } from "../fake";
import {
	assertBusinessRegistrationCountry,
	type SubmitTollFreeVerificationInput,
	TelnyxTollFreeVerificationRequestError,
} from "./toll-free-verification";

const server: FakeTelnyxServer = await startFakeTelnyxServer();

afterAll(async () => {
	await server.close();
});

beforeEach(() => {
	server.state.reset();
});

function makeClient() {
	return createTelnyxClient({
		apiKey: "KEY0123456789",
		baseUrl: server.baseUrl,
		sleep: async () => {},
		random: () => 0,
	});
}

function submission(
	overrides: Partial<SubmitTollFreeVerificationInput> = {},
): SubmitTollFreeVerificationInput {
	return {
		businessName: "Acme Plumbing",
		corporateWebsite: "https://acme.test",
		businessAddr1: "1 Main St",
		businessCity: "Springfield",
		businessState: "IL",
		businessZip: "62701",
		businessContactFirstName: "Jane",
		businessContactLastName: "Doe",
		businessContactEmail: "jane@acme.test",
		businessContactPhone: "+12125551000",
		businessRegistrationNumber: "12-3456789",
		businessRegistrationType: "EIN",
		businessRegistrationCountry: "US",
		messageVolume: "10,000",
		phoneNumbers: [{ phoneNumber: "+18005551000" }],
		useCase: "Customer Care",
		useCaseSummary: "Appointment reminders for booked jobs.",
		productionMessageContent: "Your plumber arrives at 9am. Reply STOP to opt out.",
		optInWorkflow: "Customers tick a box on the booking form.",
		optInWorkflowImageURLs: [{ url: "https://acme.test/optin.png" }],
		privacyPolicyURL: "https://acme.test/privacy",
		termsAndConditionURL: "https://acme.test/terms",
		...overrides,
	};
}

describe("tollFreeVerification.submit", () => {
	it("submits, reads back, updates and deletes", async () => {
		const client = makeClient();
		const created = await client.tollFreeVerification.submit(submission());
		expect(created.verificationStatus).toBe("In Progress");
		expect(created.businessRegistrationNumber).toBe("12-3456789");

		expect((await client.tollFreeVerification.get(created.id)).id).toBe(created.id);
		expect(await client.tollFreeVerification.list("In Progress")).toHaveLength(1);

		const updated = await client.tollFreeVerification.update(created.id, {
			businessName: "Acme Plumbing LLC",
		});
		expect(updated.businessName).toBe("Acme Plumbing LLC");

		await client.tollFreeVerification.remove(created.id);
		expect(await client.tollFreeVerification.list()).toHaveLength(0);
	});

	/** camelCase body on a snake_case path — the property most likely to be "fixed" by mistake. */
	it("sends a camelCase body with the SCREAMING URL suffixes intact", async () => {
		const client = makeClient();
		await client.tollFreeVerification.submit(submission());
		const request = server.state.requests.find(
			(entry) => entry.path === "/messaging_tollfree/verification/requests",
		);
		const keys = Object.keys(request?.body as object);
		expect(keys).toContain("businessRegistrationNumber");
		expect(keys).toContain("privacyPolicyURL");
		expect(keys).not.toContain("business_registration_number");
	});

	it("upper-cases a lowercase BRN country before the round trip", async () => {
		const client = makeClient();
		const created = await client.tollFreeVerification.submit(
			submission({ businessRegistrationCountry: "us" }),
		);
		expect(created.businessRegistrationCountry).toBe("US");
	});

	it("rejects a malformed BRN country locally, naming the field", async () => {
		const client = makeClient();
		const before = server.state.requests.length;
		await expect(
			client.tollFreeVerification.submit(submission({ businessRegistrationCountry: "USA" })),
		).rejects.toBeInstanceOf(TelnyxTollFreeVerificationRequestError);
		expect(server.state.requests.length).toBe(before);
	});
});

describe("assertBusinessRegistrationCountry", () => {
	it("normalises a valid code and rejects everything else", () => {
		expect(assertBusinessRegistrationCountry("gb")).toBe("GB");
		for (const bad of ["", "U", "USA", "1S", "U S"]) {
			expect(() => assertBusinessRegistrationCountry(bad)).toThrow(
				TelnyxTollFreeVerificationRequestError,
			);
		}
	});
});
