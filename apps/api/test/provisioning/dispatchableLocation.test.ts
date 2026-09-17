import { expect } from "chai";
import { softphonePayload } from "../../src/provisioning/catalog/templates/softphone";
import { assertMayWriteDispatchableLocation } from "../../src/provisioning/devices/devices.service";
import { ProvisionService } from "../../src/provisioning/render/provision.service";
import type { RenderContext } from "../../src/provisioning/catalog/render-context";
import type { ConfiguredProvisioningEnv } from "../../src/provisioning/provisioning-env";
import type { RenderSnapshot } from "../../src/provisioning/render/provision.repository";

/**
 * The per-device dispatchable location, at the seam where it is decided.
 *
 * RAY BAUM'S §9.8 asks for the location of the CALLING PARTY, and until `device.emergency_address_id`
 * existed the finest granularity this product had was the DID: two desks on one extension shared one
 * address, so a responder was sent to the building. These assertions pin the three answers the
 * render path can now give — a located handset, a handset that refines an address it does not own,
 * and the ordinary handset that claims nothing — and the one place a user can actually READ the
 * answer, which is the softphone payload.
 *
 * Asserted at `buildContext`, the pure function of a snapshot that `provision.service.ts` documents
 * as the one place environment and derivation happen, so this needs no database, no token and no
 * broker. Same seam and same reasoning as `sharedLineDerivation.test.ts`.
 */

const ORG = "019fd3c2-1111-7000-8000-000000000001";
const EXTENSION_ID = "019fd3c2-2222-7000-8000-000000000002";
const ADDRESS_ID = "019fd3c2-8888-7000-8000-000000000008";

const ENV = {
	PROVISION_SIP_SERVER: "pbx.example.test",
	PROVISION_SIP_SECRET_KEY: "test-root-key-0123456789abcdef",
	PROVISION_SIP_OUTBOUND_PROXY: undefined,
	PROVISION_BASE_URL: undefined,
} as unknown as ConfiguredProvisioningEnv;

function buildContext(snapshot: RenderSnapshot): RenderContext {
	const service = new ProvisionService(
		undefined as never,
		undefined as never,
		ENV,
		undefined as never,
		undefined as never,
	) as unknown as {
		buildContext(
			env: ConfiguredProvisioningEnv,
			organizationId: string,
			snapshot: RenderSnapshot,
			token: string,
			sipDomain: string,
		): RenderContext;
	};
	return service.buildContext(ENV, ORG, snapshot, "token", "pbx.example.test");
}

describe("provisioning — per-device dispatchable location", () => {
	it("resolves the handset's address and its desk detail into one line", () => {
		const context = buildContext(snapshot({ addressId: ADDRESS_ID, detail: "Desk 12" }));
		expect(context.dispatchableLocation?.formatted).to.equal(
			"HQ, 1 Main St, Floor 3, Desk 12, New York, NY, 10001, US",
		);
		expect(context.dispatchableLocation?.addressId).to.equal(ADDRESS_ID);
		expect(context.dispatchableLocation?.detail).to.equal("Desk 12");
		expect(context.dispatchableLocation?.validated).to.equal(true);
	});

	it("puts the desk detail beside the floor it refines, not after the country", () => {
		// The order is the whole point of threading the detail through the formatter rather than
		// appending it to the finished string: a dispatcher reads a location as an address, and "10001,
		// US, Desk 12" is not one.
		const formatted = buildContext(snapshot({ addressId: ADDRESS_ID, detail: "Desk 12" }))
			.dispatchableLocation?.formatted;
		expect(formatted?.indexOf("Desk 12")).to.be.lessThan(formatted?.indexOf("New York") ?? 0);
	});

	it("reports nothing for a handset that names only a detail", () => {
		// "Desk 12" is a refinement of a location, not a location: a phone's own configuration has no
		// address to refine, so this surface says nothing rather than something undrivable. The
		// notification path DOES have the number's address in hand and does combine them —
		// `emergencyNotification.test.ts` pins that.
		const context = buildContext(snapshot({ addressId: null, detail: "Desk 12" }));
		expect(context.dispatchableLocation).to.equal(undefined);
	});

	it("reports nothing for the ordinary handset that claims no location", () => {
		// The pre-existing state of every device in every deployment. It must stay silent rather than
		// become an empty string a client would render as a blank address.
		expect(buildContext(snapshot({ addressId: null, detail: null })).dispatchableLocation).to.equal(
			undefined,
		);
	});

	it("carries the location into the softphone payload, unvalidated flag and all", () => {
		// The softphone is the one endpoint that can show a user where a 911 call from it will be
		// dispatched BEFORE they need to know. `validated: false` is carried rather than hidden,
		// because an address nobody checked is exactly the one worth looking at.
		const payload = softphonePayload(
			buildContext(snapshot({ addressId: ADDRESS_ID, detail: "Desk 12", validated: false })),
		);
		expect(payload.dispatchableLocation?.formatted).to.contain("Desk 12");
		expect(payload.dispatchableLocation?.validated).to.equal(false);
	});

	it("reports null rather than omitting the key when a softphone has no location", () => {
		// A missing key and a null are different answers to "where is this?", and only one of them is
		// distinguishable from a client that forgot to read the field.
		const payload = softphonePayload(buildContext(snapshot({ addressId: null, detail: null })));
		expect(payload.dispatchableLocation).to.equal(null);
	});
});

describe("provisioning — who may set a dispatchable location", () => {
	/** A session holding exactly the grants named. */
	const session = (...permissions: readonly string[]) =>
		({ user: { id: "user-1" }, permissions }) as never;

	it("refuses a device.write holder who does not hold numbers.emergency", () => {
		// `devices.write` is "who may configure a phone" — a deskside technician holds it. Saying where
		// a 911 call comes from is the narrower grant, and letting the wider one do it would make
		// `numbers.emergency` decorative: an operator refused at the address CRUD could simply repoint
		// every device instead.
		expect(() =>
			assertMayWriteDispatchableLocation(session("devices.write"), {
				emergencyAddressId: ADDRESS_ID,
			}),
		).to.throw(/numbers.emergency/u);
	});

	it("refuses a bare detail for the same reason", () => {
		expect(() =>
			assertMayWriteDispatchableLocation(session("devices.write"), {
				emergencyLocationDetail: "Desk 12",
			}),
		).to.throw(/numbers.emergency/u);
	});

	it("leaves every other device edit alone", () => {
		// The whole point of checking presence in the service rather than declaring a floor on the
		// decorator: a `devices.write`-only holder must still be able to rename a phone.
		expect(() =>
			assertMayWriteDispatchableLocation(session("devices.write"), { label: "Reception" }),
		).to.not.throw();
	});

	it("allows the write when the caller holds numbers.emergency", () => {
		expect(() =>
			assertMayWriteDispatchableLocation(session("devices.write", "numbers.emergency"), {
				emergencyAddressId: ADDRESS_ID,
				emergencyLocationDetail: "Desk 12",
			}),
		).to.not.throw();
	});

	it("refuses an explicit null too — clearing a location is setting one", () => {
		// Presence, not truthiness: `{ emergencyAddressId: null }` erases the address a dispatcher
		// would have been read, which is exactly the change the grant exists to control.
		expect(() =>
			assertMayWriteDispatchableLocation(session("devices.write"), { emergencyAddressId: null }),
		).to.throw(/numbers.emergency/u);
	});
});

/** A one-line softphone snapshot whose device carries the location the test describes. */
function snapshot(location: {
	addressId: string | null;
	detail: string | null;
	validated?: boolean;
}): RenderSnapshot {
	return {
		device: {
			id: "019fd3c2-4444-7000-8000-000000000004",
			vendor: "softphone",
			model: "GENERIC",
			macAddress: "001565abcdef",
			label: "Reception",
			settings: {},
			emergencyAddressId: location.addressId,
			emergencyLocationDetail: location.detail,
		},
		profile: undefined,
		lines: [
			{
				line: {
					lineNumber: 1,
					enabled: true,
					extensionId: EXTENSION_ID,
					authUser: null,
					sipSecretRef: null,
					serverAddress: null,
					serverPort: 5060,
					transport: "udp",
					registerExpiresSeconds: 3600,
					sharedLine: false,
					label: null,
				},
				extension: {
					id: EXTENSION_ID,
					number: "1001",
					sipSecretRef: "secret-ref",
					callerIdName: "Alice Nguyen",
					label: "Reception",
					voicemailEnabled: false,
				},
			},
		],
		keys: [],
		profileKeys: [],
		// The repository only reads this when the device names an address, so a device that names none
		// arrives here with `undefined` exactly as it does in production.
		emergencyAddress:
			location.addressId === null
				? undefined
				: {
						id: location.addressId,
						label: "HQ",
						streetLine1: "1 Main St",
						streetLine2: null,
						locationDetail: "Floor 3",
						locality: "New York",
						administrativeArea: "NY",
						postalCode: "10001",
						country: "US",
						validated: location.validated ?? true,
					},
		organizationSettings: {},
		sharedLineExtensionIds: new Set<string>(),
	} as unknown as RenderSnapshot;
}
