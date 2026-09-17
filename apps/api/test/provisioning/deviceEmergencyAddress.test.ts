import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { EmergencyAddressNotValidatedException } from "../../src/pbx/emergency-addresses/emergency-addresses.errors";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import { DevicesService } from "../../src/provisioning/devices/devices.service";
import type { EmergencyAddressesService } from "../../src/pbx/emergency-addresses/emergency-addresses.service";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { ProvisioningEnv } from "../../src/provisioning/provisioning-env";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The E911 gate on a device's dispatchable location.
 *
 * A DID refuses an unvalidated emergency address (`phone-numbers.service.ts`); a handset carries
 * the same column and must refuse it for the same reason, or the DID gate is bypassed by attaching
 * the address to the phone instead. What is under test is the WIRING — that the device write asks,
 * that it asks only when the write names the column, and that the refusal is the same named error —
 * so `EmergencyAddressesService` is a double. Its own decision has its own suite
 * (`test/pbx/emergencyAddressValidation.test.ts`), against a real carrier fake.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const DEVICE_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const VALIDATED = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const UNVALIDATED = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

function session(): AppSession {
	return {
		session: { id: "sess", userId: "u", activeOrganizationId: ORG },
		user: { id: "u", email: "u@test", name: "U", emailVerified: true },
		permissions: ["devices.write", "numbers.emergency"],
	} as unknown as AppSession;
}

/** Records every write that reached the repository, so a refusal can be shown to have stopped one. */
function fakeRuntime(): {
	readonly runtime: PbxRepositoryRuntime;
	readonly writes: Record<string, unknown>[];
} {
	const writes: Record<string, unknown>[] = [];
	const repository = {
		get: (_organizationId: string, _resource: unknown, id: string) =>
			Effect.succeed({ id, organizationId: ORG }),
		create: (_organizationId: string, _resource: unknown, values: Record<string, unknown>) => {
			writes.push(values);
			return Effect.succeed({ row: { id: DEVICE_ID, ...values }, warnings: [] });
		},
		update: (
			_organizationId: string,
			_resource: unknown,
			id: string,
			values: Record<string, unknown>,
		) => {
			writes.push(values);
			return Effect.succeed({ row: { id, ...values }, warnings: [] });
		},
		list: () => Effect.succeed({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
		remove: () => Effect.succeed({ row: { id: DEVICE_ID }, warnings: [] }),
		compile: () => Effect.succeed({} as never),
	} as unknown as PbxRepositoryInterface;

	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), writes };
}

/** Validated for `VALIDATED`, refused for anything else — the real service's shape, decided here. */
function addresses(): {
	readonly service: EmergencyAddressesService;
	readonly asked: (string | null)[];
} {
	const asked: (string | null)[] = [];
	const service = {
		assertAssignable: async (
			_session: AppSession,
			addressId: string | null | undefined,
			subject = "this record",
		): Promise<void> => {
			if (addressId === null || addressId === undefined || addressId.length === 0) {
				asked.push(null);
				return;
			}
			asked.push(addressId);
			if (addressId !== VALIDATED) {
				throw new EmergencyAddressNotValidatedException(addressId, subject);
			}
		},
	} as unknown as EmergencyAddressesService;
	return { service, asked };
}

function devices(
	runtime: PbxRepositoryRuntime,
	emergency: EmergencyAddressesService,
): DevicesService {
	return new DevicesService(
		runtime,
		{ PROVISION_TOKEN_TTL_DAYS: 0 } as unknown as ProvisioningEnv,
		{} as unknown as PbxDatabaseClient,
		emergency,
	);
}

describe("device dispatchable location — validated address gate", () => {
	it("refuses to attach an unvalidated address on create, and writes nothing", async () => {
		const { runtime, writes } = fakeRuntime();
		const { service } = addresses();
		let thrown: unknown;
		try {
			await devices(runtime, service).create(session(), {
				macAddress: "AABBCCDDEEFF",
				emergencyAddressId: UNVALIDATED,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(EmergencyAddressNotValidatedException);
		const body = (thrown as EmergencyAddressNotValidatedException).getResponse() as {
			code: string;
			addressId: string;
			message: string;
		};
		expect(body.code).to.equal("EMERGENCY_ADDRESS_NOT_VALIDATED");
		expect(body.addressId).to.equal(UNVALIDATED);
		expect(body.message).to.contain("device AABBCCDDEEFF");
		expect(writes).to.have.length(0);
	});

	it("refuses on update too", async () => {
		const { runtime, writes } = fakeRuntime();
		const { service } = addresses();
		let thrown: unknown;
		try {
			await devices(runtime, service).update(session(), DEVICE_ID, {
				emergencyAddressId: UNVALIDATED,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(EmergencyAddressNotValidatedException);
		expect(writes).to.have.length(0);
	});

	it("allows a validated address", async () => {
		const { runtime, writes } = fakeRuntime();
		const { service, asked } = addresses();
		await devices(runtime, service).update(session(), DEVICE_ID, {
			emergencyAddressId: VALIDATED,
		});
		expect(asked).to.deep.equal([VALIDATED]);
		expect(writes).to.have.length(1);
	});

	it("allows clearing the address whatever its state", async () => {
		const { runtime, writes } = fakeRuntime();
		const { service, asked } = addresses();
		await devices(runtime, service).update(session(), DEVICE_ID, { emergencyAddressId: null });
		expect(asked).to.deep.equal([null]);
		expect(writes).to.have.length(1);
	});

	it("does not ask when the write does not name the column", async () => {
		const { runtime, writes } = fakeRuntime();
		const { service, asked } = addresses();
		await devices(runtime, service).update(session(), DEVICE_ID, { label: "Reception" });
		expect(asked).to.have.length(0);
		expect(writes).to.have.length(1);
	});

	it("gates the create-with-token path, which is the only way a device is created", async () => {
		const { runtime, writes } = fakeRuntime();
		const { service } = addresses();
		let thrown: unknown;
		try {
			await devices(runtime, service).createWithProvisioningToken(session(), {
				macAddress: "AABBCCDDEE01",
				emergencyAddressId: UNVALIDATED,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(EmergencyAddressNotValidatedException);
		expect(writes).to.have.length(0);
	});
});
