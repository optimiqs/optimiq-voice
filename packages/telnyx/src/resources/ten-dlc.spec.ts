import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createTelnyxClient, type TelnyxClient } from "../client";
import { TelnyxApiError } from "../errors";
import { FAKE_BRAND_OTP_PIN, type FakeTelnyxServer, startFakeTelnyxServer } from "../fake";

/**
 * The 10DLC sequence, against the fake carrier.
 *
 * The three refusals below are the whole reason this surface exists: an unverified brand's
 * campaign never reaches `ACTIVE`, a non-`ACTIVE` campaign will not take a number, and a US local
 * number with no campaign cannot send. Each is exercised here because in production the first two
 * fail loudly and the third fails *silently* — carrier filtering, no error, no delivery.
 */

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

/** Buys a number and puts it on a messaging profile — the precondition for a campaign assignment. */
async function provisionMessagingNumber(client: TelnyxClient): Promise<string> {
	const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
	const phoneNumber = search.data[0]?.phone_number ?? "";
	await client.numberOrders.create({ phoneNumbers: [phoneNumber], customerReference: "spec" });
	const owned = server.state.find(phoneNumber);
	const profile = await client.messagingProfiles.create({ name: "spec profile" });
	await client.messagingProfiles.assignPhoneNumber(owned?.ownedId ?? "", profile.id);
	return phoneNumber;
}

describe("tenDlc brand", () => {
	it("creates a sole-proprietor brand and verifies it over the SMS OTP round trip", async () => {
		const client = makeClient();
		const brand = await client.tenDlc.createBrand({
			entityType: "SOLE_PROPRIETOR",
			displayName: "Jane's Plumbing",
			country: "US",
			email: "jane@example.test",
			vertical: "PROFESSIONAL",
		});
		expect(brand.identityStatus).toBe("UNVERIFIED");
		expect((await client.tenDlc.getBrand(brand.brandId)).brandId).toBe(brand.brandId);

		await client.tenDlc.triggerBrandOtp(brand.brandId, { pinSms: "Your PIN is @OTP_PIN@" });
		const verified = await client.tenDlc.verifyBrandOtp(brand.brandId, FAKE_BRAND_OTP_PIN);
		expect(verified.identityStatus).toBe("VERIFIED");

		expect(await client.tenDlc.listBrands()).toHaveLength(1);
		await client.tenDlc.deleteBrand(brand.brandId);
		expect(await client.tenDlc.listBrands()).toHaveLength(0);
	});

	it("rejects a wrong PIN", async () => {
		const client = makeClient();
		const brand = await client.tenDlc.createBrand({
			entityType: "SOLE_PROPRIETOR",
			displayName: "Jane's Plumbing",
			country: "US",
			email: "jane@example.test",
			vertical: "PROFESSIONAL",
		});
		await client.tenDlc.triggerBrandOtp(brand.brandId);
		await expect(client.tenDlc.verifyBrandOtp(brand.brandId, "000000")).rejects.toBeInstanceOf(
			TelnyxApiError,
		);
	});

	/** The camelCase property, asserted rather than assumed — see the module header. */
	it("sends a camelCase body to a camelCase path", async () => {
		const client = makeClient();
		await client.tenDlc.createBrand({
			entityType: "PRIVATE_PROFIT",
			displayName: "Acme",
			country: "US",
			email: "ops@example.test",
			vertical: "TECHNOLOGY",
			ein: "123456789",
		});
		const request = server.state.requests.find((entry) => entry.path === "/10dlc/brand");
		expect(Object.keys(request?.body as object)).toContain("displayName");
		expect(Object.keys(request?.body as object)).not.toContain("display_name");
	});
});

describe("tenDlc campaign", () => {
	async function verifiedBrandId(client: TelnyxClient): Promise<string> {
		const brand = await client.tenDlc.createBrand({
			entityType: "PRIVATE_PROFIT",
			displayName: "Acme",
			country: "US",
			email: "ops@example.test",
			vertical: "TECHNOLOGY",
			ein: "123456789",
		});
		return brand.brandId;
	}

	it("creates a campaign under a vetted brand and assigns a number to it", async () => {
		const client = makeClient();
		const phoneNumber = await provisionMessagingNumber(client);
		const campaign = await client.tenDlc.createCampaign({
			brandId: await verifiedBrandId(client),
			usecase: "CUSTOMER_CARE",
			description: "appointment reminders",
			sample1: "Your appointment is confirmed.",
		});
		expect(campaign.status).toBe("ACTIVE");
		expect((await client.tenDlc.getCampaign(campaign.campaignId)).campaignId).toBe(
			campaign.campaignId,
		);
		expect(await client.tenDlc.listCampaigns(campaign.brandId)).toHaveLength(1);

		const assignment = await client.tenDlc.assignPhoneNumber(phoneNumber, campaign.campaignId);
		expect(assignment.phoneNumber).toBe(phoneNumber);
		expect(assignment.assignmentStatus).toBe("SUCCESS");

		await client.tenDlc.unassignPhoneNumber(phoneNumber);
		expect(server.state.phoneNumberCampaigns.size).toBe(0);
	});

	it("refuses an assignment when the campaign is not ACTIVE", async () => {
		const client = makeClient();
		const phoneNumber = await provisionMessagingNumber(client);
		// A sole proprietor who has not completed the OTP: the campaign stays TCR_PENDING.
		const brand = await client.tenDlc.createBrand({
			entityType: "SOLE_PROPRIETOR",
			displayName: "Jane's Plumbing",
			country: "US",
			email: "jane@example.test",
			vertical: "PROFESSIONAL",
		});
		const campaign = await client.tenDlc.createCampaign({
			brandId: brand.brandId,
			usecase: "CUSTOMER_CARE",
			description: "appointment reminders",
			sample1: "Your appointment is confirmed.",
		});
		expect(campaign.status).toBe("TCR_PENDING");
		await expect(
			client.tenDlc.assignPhoneNumber(phoneNumber, campaign.campaignId),
		).rejects.toBeInstanceOf(TelnyxApiError);
	});

	it("refuses an assignment for a number that is on no messaging profile", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const phoneNumber = search.data[0]?.phone_number ?? "";
		await client.numberOrders.create({ phoneNumbers: [phoneNumber], customerReference: "spec" });
		const campaign = await client.tenDlc.createCampaign({
			brandId: await verifiedBrandId(client),
			usecase: "CUSTOMER_CARE",
			description: "appointment reminders",
			sample1: "Your appointment is confirmed.",
		});
		await expect(
			client.tenDlc.assignPhoneNumber(phoneNumber, campaign.campaignId),
		).rejects.toBeInstanceOf(TelnyxApiError);
	});
});

describe("the registration gate on sending", () => {
	it("refuses a US local send with no ACTIVE campaign, and allows it once assigned", async () => {
		const client = makeClient();
		const phoneNumber = await provisionMessagingNumber(client);
		await expect(
			client.messages.send({ from: phoneNumber, to: "+14155559999", text: "hi", clientState: "c" }),
		).rejects.toBeInstanceOf(TelnyxApiError);

		const brand = await client.tenDlc.createBrand({
			entityType: "PRIVATE_PROFIT",
			displayName: "Acme",
			country: "US",
			email: "ops@example.test",
			vertical: "TECHNOLOGY",
			ein: "123456789",
		});
		const campaign = await client.tenDlc.createCampaign({
			brandId: brand.brandId,
			usecase: "CUSTOMER_CARE",
			description: "appointment reminders",
			sample1: "Your appointment is confirmed.",
		});
		await client.tenDlc.assignPhoneNumber(phoneNumber, campaign.campaignId);

		const message = await client.messages.send({
			from: phoneNumber,
			to: "+14155559999",
			text: "hi",
			clientState: "c",
		});
		expect(message.direction).toBe("outbound");
	});

	it("can be switched off for specs that are not about registration", async () => {
		const client = makeClient();
		server.state.allowUnregisteredSend = true;
		const message = await client.messages.send({
			from: "+12125551000",
			to: "+14155559999",
			text: "hi",
			clientState: "c",
		});
		expect(message.id.length).toBeGreaterThan(0);
	});
});

describe("messagingProfiles", () => {
	it("pins webhook_api_version to 2, whatever the caller does", async () => {
		const client = makeClient();
		const profile = await client.messagingProfiles.create({ name: "spec profile" });
		expect(profile.webhook_api_version).toBe("2");
	});

	it("attaches and detaches a DID, and lists what is attached", async () => {
		const client = makeClient();
		const phoneNumber = await provisionMessagingNumber(client);
		const [profile] = await client.messagingProfiles.list();
		const attached = await client.messagingProfiles.listPhoneNumbers(profile?.id ?? "");
		expect(attached.map((entry) => entry.phone_number)).toEqual([phoneNumber]);

		const numberId = server.state.find(phoneNumber)?.ownedId ?? "";
		const detached = await client.messagingProfiles.assignPhoneNumber(numberId, null);
		expect(detached.messaging_profile_id).toBeNull();
		expect(await client.messagingProfiles.listPhoneNumbers(profile?.id ?? "")).toHaveLength(0);
	});
});
