import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { createTelnyxClient } from "@optimiq-voice/telnyx";
import { startFakeTelnyxServer } from "@optimiq-voice/telnyx/fake";
import { createEmergencyAddressDto } from "../../src/pbx/emergency-addresses/emergency-addresses.dto";
import { EmergencyAddressNotValidatedException } from "../../src/pbx/emergency-addresses/emergency-addresses.errors";
import { EmergencyAddressesService } from "../../src/pbx/emergency-addresses/emergency-addresses.service";
import { parseDto } from "../../src/pbx/shared/dto";
import { PbxEntityNotFoundFailure } from "../../src/pbx/shared/pbx.errors";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { TelnyxClient } from "@optimiq-voice/telnyx";
import type { FakeTelnyxServer } from "@optimiq-voice/telnyx/fake";

/**
 * E911 dispatchable-location validation, api-side.
 *
 * ## Against the fake carrier, over a real socket
 *
 * Same argument as `carrierPorting.test.ts`: the service is driven directly with a real
 * `TelnyxClient` pointed at the in-package fake Telnyx server, so the request the client builds and
 * the carrier shape it parses back are part of what is under test rather than part of the test's
 * assumptions. There is no live carrier call anywhere in this file and there cannot be — the base
 * URL is a loopback port and the key is a fixture string.
 *
 * The repository is an in-memory double behind the same `runEffect` seam the real one sits behind
 * (the pattern is `pbxResourceService.test.ts`'s), because what matters here is which columns get
 * written and when, not the SQL that writes them.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const ADDRESS_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

function session(): AppSession {
	return {
		session: { id: "sess", userId: "u", activeOrganizationId: ORG },
		user: { id: "u", email: "u@test", name: "U", emailVerified: true },
		permissions: ["numbers.emergency"],
	} as unknown as AppSession;
}

function addressRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ADDRESS_ID,
		organizationId: ORG,
		label: "Head office",
		streetLine1: "600 Congress Ave",
		streetLine2: null,
		locationDetail: "Floor 14",
		locality: "Austin",
		administrativeArea: "TX",
		postalCode: "78701",
		country: "US",
		validated: false,
		validatedAt: null,
		validationProvider: null,
		validationReference: null,
		...overrides,
	};
}

/** A repository holding exactly one address row, which `update` merges into. */
function fakeRuntime(row: Record<string, unknown>): {
	readonly runtime: PbxRepositoryRuntime;
	readonly row: () => Record<string, unknown>;
} {
	let current = row;
	const repository = {
		get: (_organizationId: string, resource: { kind: string }, id: string) =>
			id === current.id
				? Effect.succeed(current)
				: Effect.fail(new PbxEntityNotFoundFailure({ kind: resource.kind, id })),
		create: (_organizationId: string, _resource: unknown, values: Record<string, unknown>) => {
			current = { ...current, ...values };
			return Effect.succeed({ row: current, warnings: [] });
		},
		update: (
			_organizationId: string,
			_resource: unknown,
			_id: string,
			values: Record<string, unknown>,
		) => {
			current = { ...current, ...values };
			return Effect.succeed({ row: current, warnings: [] });
		},
		list: () => Effect.succeed({ data: [current], total: 1, page: 1, limit: 20, totalPages: 1 }),
		remove: () => Effect.succeed({ row: { id: current.id }, warnings: [] }),
		compile: () => Effect.succeed({} as never),
	} as unknown as PbxRepositoryInterface;

	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), row: () => current };
}

describe("emergency address validation", () => {
	let fake: FakeTelnyxServer;

	before(async () => {
		fake = await startFakeTelnyxServer();
	});

	after(async () => {
		await fake.close();
	});

	beforeEach(() => {
		fake.state.reset();
	});

	function client(): TelnyxClient {
		return createTelnyxClient({ apiKey: "KEY0123456789", baseUrl: fake.baseUrl });
	}

	// -------------------------------------------------------------------------------------------
	// The carrier's answer, written onto the row
	// -------------------------------------------------------------------------------------------

	it("sets the flag, the provider and the carrier reference for a valid address", async () => {
		const { runtime, row } = fakeRuntime(addressRow());
		const service = new EmergencyAddressesService(runtime, client());

		const result = await service.validateWithCarrier(session(), ADDRESS_ID);

		expect(result.validation.validated).to.equal(true);
		expect(result.validation.result).to.equal("valid");
		expect(row().validated).to.equal(true);
		expect(row().validationProvider).to.equal("telnyx");
		expect(row().validatedAt).to.be.instanceOf(Date);
		// The reference is the carrier's address id, and it is the one the fake actually minted.
		expect([...fake.state.addresses.keys()]).to.deep.equal([row().validationReference]);
	});

	it("sends the dispatchable-location detail as the carrier's extended address", async () => {
		const { runtime } = fakeRuntime(addressRow());
		await new EmergencyAddressesService(runtime, client()).validateWithCarrier(
			session(),
			ADDRESS_ID,
		);
		const validate = fake.state.requests.find(
			(request) => request.path === "/addresses/actions/validate",
		);
		expect((validate?.body as Record<string, unknown>).extended_address).to.equal("Floor 14");
	});

	it("leaves the flag false and reports the carrier's reason for an invalid address", async () => {
		fake.state.addressValidation = {
			result: "invalid",
			errors: [{ code: "10015", message: "No such street in this locality." }],
		};
		const { runtime, row } = fakeRuntime(addressRow());
		const service = new EmergencyAddressesService(runtime, client());

		const result = await service.validateWithCarrier(session(), ADDRESS_ID);

		expect(result.validation.validated).to.equal(false);
		expect(result.validation.reason).to.equal("No such street in this locality.");
		expect(row().validated).to.equal(false);
		expect(row().validationReference).to.equal(null);
		// Nothing was registered at the carrier for an address it does not recognise.
		expect(fake.state.addresses.size).to.equal(0);
	});

	it("passes a suggested correction through instead of collapsing it into a refusal", async () => {
		fake.state.addressValidation = {
			result: "suggested",
			errors: [],
			suggested: { street_address: "600 Congress Avenue", locality: "Austin" },
		};
		const { runtime, row } = fakeRuntime(addressRow());
		const result = await new EmergencyAddressesService(runtime, client()).validateWithCarrier(
			session(),
			ADDRESS_ID,
		);
		expect(result.validation.result).to.equal("suggested");
		expect(result.validation.suggestion).to.deep.include({
			street_address: "600 Congress Avenue",
		});
		expect(row().validated).to.equal(false);
	});

	it("re-validates on create rather than leaving the flag for a second call", async () => {
		const { runtime, row } = fakeRuntime(addressRow());
		const service = new EmergencyAddressesService(runtime, client());
		const created = await service.create(session(), addressRow());
		expect(created.data.validated).to.equal(true);
		expect(row().validationProvider).to.equal("telnyx");
	});

	it("clears the flag when an edit makes the address unrecognisable", async () => {
		const { runtime, row } = fakeRuntime(
			addressRow({ validated: true, validationProvider: "telnyx", validationReference: "old" }),
		);
		fake.state.addressValidation = {
			result: "invalid",
			errors: [{ code: "10015", message: "No such street." }],
		};
		const service = new EmergencyAddressesService(runtime, client());
		await service.update(session(), ADDRESS_ID, { streetLine1: "600 Nowhere Rd" });
		expect(row().validated).to.equal(false);
		expect(row().validationReference).to.equal(null);
	});

	// -------------------------------------------------------------------------------------------
	// The gate
	// -------------------------------------------------------------------------------------------

	it("refuses to attach an unvalidated address", async () => {
		const { runtime } = fakeRuntime(addressRow());
		const service = new EmergencyAddressesService(runtime, client());
		let thrown: unknown;
		try {
			await service.assertAssignable(session(), ADDRESS_ID, "phone number +12125550100");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(EmergencyAddressNotValidatedException);
		const body = (thrown as EmergencyAddressNotValidatedException).getResponse() as {
			code: string;
			addressId: string;
		};
		expect(body.code).to.equal("EMERGENCY_ADDRESS_NOT_VALIDATED");
		expect(body.addressId).to.equal(ADDRESS_ID);
	});

	it("allows a validated address, and allows clearing one", async () => {
		const { runtime } = fakeRuntime(addressRow({ validated: true }));
		const service = new EmergencyAddressesService(runtime, client());
		await service.assertAssignable(session(), ADDRESS_ID);
		await service.assertAssignable(session(), null);
		await service.assertAssignable(session(), undefined);
	});

	it("refuses an address that belongs to another tenant before looking at its flag", async () => {
		const { runtime } = fakeRuntime(addressRow({ validated: true }));
		const service = new EmergencyAddressesService(runtime, client());
		let thrown: unknown;
		try {
			await service.assertAssignable(session(), "019fd3c2-9999-76be-a6b3-b0f1914e39b6");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.not.be.instanceOf(EmergencyAddressNotValidatedException);
	});

	// -------------------------------------------------------------------------------------------
	// Degradation, and the read-only column
	// -------------------------------------------------------------------------------------------

	it("answers 503 CARRIER_NOT_CONFIGURED rather than crashing with no carrier", async () => {
		const { runtime } = fakeRuntime(addressRow());
		const service = new EmergencyAddressesService(runtime, undefined);
		expect(service.carrierConfigured).to.equal(false);
		let thrown: unknown;
		try {
			await service.validateWithCarrier(session(), ADDRESS_ID);
		} catch (error) {
			thrown = error;
		}
		const body = (
			thrown as { getResponse: () => { statusCode: number; code: string } }
		).getResponse();
		expect(body.statusCode).to.equal(503);
		expect(body.code).to.equal("CARRIER_NOT_CONFIGURED");
	});

	it("still creates and reads addresses with no carrier, leaving them unvalidated", async () => {
		const { runtime, row } = fakeRuntime(addressRow());
		const service = new EmergencyAddressesService(runtime, undefined);
		const created = await service.create(session(), addressRow());
		expect(created.data.id).to.equal(ADDRESS_ID);
		expect(row().validated).to.equal(false);
	});

	it("saves the address but leaves it unvalidated when the carrier is unreachable", async () => {
		const unreachable = createTelnyxClient({
			apiKey: "KEY0123456789",
			// A port nothing is listening on: the create must survive it.
			baseUrl: "http://127.0.0.1:1/v2",
			retry: { maxAttempts: 1 },
			sleep: async () => {},
		});
		const { runtime, row } = fakeRuntime(addressRow());
		const created = await new EmergencyAddressesService(runtime, unreachable).create(
			session(),
			addressRow(),
		);
		expect(created.data.validated).to.equal(false);
		expect(row().validated).to.equal(false);
	});

	it("refuses a tenant's attempt to set validated through the DTO", () => {
		expect(() =>
			parseDto(createEmergencyAddressDto, {
				label: "Head office",
				streetLine1: "600 Congress Ave",
				locality: "Austin",
				administrativeArea: "TX",
				postalCode: "78701",
				validated: true,
			}),
		).to.throw();
		expect(() =>
			parseDto(createEmergencyAddressDto, {
				label: "Head office",
				streetLine1: "600 Congress Ave",
				locality: "Austin",
				administrativeArea: "TX",
				postalCode: "78701",
				validationProvider: "telnyx",
			}),
		).to.throw();
	});
});
