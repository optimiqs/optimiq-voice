import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createTelnyxClient } from "../client";
import { TelnyxApiError } from "../errors";
import { type FakeTelnyxServer, startFakeTelnyxServer } from "../fake";
import {
	assertAddressCountry,
	isTelnyxAddressValid,
	TelnyxAddressFormatError,
} from "./e911-addresses";

/**
 * The E911 address surface, against the fake over a real socket.
 *
 * Same argument as `client.spec.ts`: the things worth testing here are the request this resource
 * builds and the carrier shape it parses back, and a stubbed `fetch` would make both part of the
 * test's assumptions.
 */

const server: FakeTelnyxServer = await startFakeTelnyxServer();

afterAll(async () => {
	await server.close();
});

beforeEach(() => {
	server.state.reset();
});

function client() {
	return createTelnyxClient({ apiKey: "KEY0123456789", baseUrl: server.baseUrl });
}

const ADDRESS = {
	streetAddress: "600 Congress Ave",
	extendedAddress: "Floor 14",
	locality: "Austin",
	administrativeArea: "TX",
	postalCode: "78701",
	countryCode: "US",
} as const;

describe("e911 addresses", () => {
	it("refuses a malformed country code before any request", () => {
		expect(() => assertAddressCountry("usa")).toThrow(TelnyxAddressFormatError);
		expect(() => assertAddressCountry("us")).toThrow(TelnyxAddressFormatError);
		expect(() => assertAddressCountry("US")).not.toThrow();
		expect(server.state.requests).toHaveLength(0);
	});

	it("validates an address and reads back the carrier's verdict", async () => {
		const answer = await client().e911Addresses.validate(ADDRESS);
		expect(answer.result).toBe("valid");
		expect(isTelnyxAddressValid(answer.result)).toBe(true);

		const [request] = server.state.requests;
		expect(request?.path).toBe("/addresses/actions/validate");
		expect(request?.body).toMatchObject({
			street_address: "600 Congress Ave",
			extended_address: "Floor 14",
			country_code: "US",
		});
	});

	it("surfaces the carrier's own reason for an invalid address", async () => {
		server.state.addressValidation = {
			result: "invalid",
			errors: [{ code: "10015", message: "No such street in this locality." }],
		};
		const answer = await client().e911Addresses.validate(ADDRESS);
		expect(answer.result).toBe("invalid");
		expect(answer.errors?.[0]?.message).toBe("No such street in this locality.");
	});

	it("carries a suggested alternative through unchanged", async () => {
		server.state.addressValidation = {
			result: "suggested",
			errors: [],
			suggested: { street_address: "600 Congress Avenue", locality: "Austin" },
		};
		const answer = await client().e911Addresses.validate(ADDRESS);
		expect(answer.result).toBe("suggested");
		expect(answer.suggested?.street_address).toBe("600 Congress Avenue");
	});

	it("creates, reads, lists and deletes an address", async () => {
		const created = await client().e911Addresses.create({
			...ADDRESS,
			customerReference: "org-1",
		});
		expect(created.id).toBeTruthy();
		expect(server.state.requests[0]?.body).toMatchObject({ validate_address: true });

		expect((await client().e911Addresses.get(created.id)).id).toBe(created.id);
		expect(await client().e911Addresses.list({ customerReference: "org-1" })).toHaveLength(1);
		expect(await client().e911Addresses.list({ customerReference: "org-2" })).toHaveLength(0);

		await client().e911Addresses.remove(created.id);
		await expect(client().e911Addresses.get(created.id)).rejects.toThrow(TelnyxApiError);
	});

	it("refuses to create an address the carrier will not validate", async () => {
		server.state.addressValidation = {
			result: "invalid",
			errors: [{ code: "10015", message: "Not a dispatchable location." }],
		};
		await expect(client().e911Addresses.create(ADDRESS)).rejects.toThrow(TelnyxApiError);
		expect(server.state.addresses.size).toBe(0);
	});
});
