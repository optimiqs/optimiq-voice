import { expect } from "chai";
import { createTelnyxClient } from "@optimiq-voice/telnyx";
import { startFakeTelnyxServer } from "@optimiq-voice/telnyx/fake";
import {
	createPortingOrderDto,
	listPortingOrdersDto,
	updateCnamListingDto,
} from "../../src/pbx/carrier/carrier.dto";
import { CarrierService } from "../../src/pbx/carrier/carrier.service";
import { parseDto } from "../../src/pbx/shared/dto";
import type { CarrierEnv } from "../../src/pbx/carrier/carrier-env";
import type { PhoneNumbersService } from "../../src/pbx/phone-numbers/phone-numbers.service";
import type { TrunksService } from "../../src/pbx/trunks/trunks.service";
import type { AppSession } from "@optimiq-voice/auth";
import type { FakeTelnyxServer } from "@optimiq-voice/telnyx/fake";

/**
 * Porting (LNP) and CNAM, api-side.
 *
 * ## Against the fake carrier, over a real socket
 *
 * `CarrierService` is driven directly, with a real `TelnyxClient` pointed at the in-package fake
 * Telnyx server — the same double `verify:carrier` boots the whole API against. That is a
 * deliberate choice over stubbing the client: the things most likely to be wrong in this slice are
 * the request the client builds and the carrier shape it parses back, and a stubbed client makes
 * both of those part of the test's assumptions rather than part of what it tests. There is **no
 * live carrier call anywhere in this file**, and there cannot be: the base URL is the fake's
 * loopback port and the key is a fixture string.
 *
 * `PhoneNumbersService` is a hand-written double rather than a real one, because the CNAM paths
 * need exactly one thing from it — the organization-scoped `get` that turns a local id into a
 * carrier ref — and standing up `pbx-db` to provide it would test Drizzle.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NUMBER_ID = "22222222-2222-4222-8222-222222222222";
const BYO_NUMBER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORDER_ID = "44444444-4444-4444-8444-444444444444";

function session(organizationId: string = ORG): AppSession {
	return { session: { activeOrganizationId: organizationId } } as unknown as AppSession;
}

function env(): CarrierEnv {
	return {
		TELNYX_API_BASE: "https://api.telnyx.com/v2",
		TELNYX_SIP_REGION: "us",
		TELNYX_DAILY_SPEND_LIMIT: "50.00",
		TELNYX_WHITELISTED_DESTINATIONS: ["US", "CA"],
	} as unknown as CarrierEnv;
}

/**
 * The rows the CNAM paths look up.
 *
 * `get` throws for an unknown id rather than returning undefined, because that is what the real
 * service does — and the whole tenant-safety argument for addressing CNAM by the LOCAL id rests on
 * that throw happening before any carrier request is built.
 */
function numbersDouble(rows: Record<string, Record<string, unknown>>): PhoneNumbersService {
	return {
		get: async (_session: AppSession, id: string) => {
			const row = rows[id];
			if (row === undefined) {
				throw new Error(`no phone number ${id}`);
			}
			return { data: row };
		},
	} as unknown as PhoneNumbersService;
}

describe("carrier porting and CNAM", () => {
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

	/** A service wired to the fake, plus one owned DID whose carrier ref the CNAM paths resolve. */
	async function serviceWithOwnedNumber(): Promise<{
		readonly carrier: CarrierService;
		readonly carrierRef: string;
		readonly e164: string;
	}> {
		const client = createTelnyxClient({ apiKey: "KEY0123456789", baseUrl: fake.baseUrl });
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const e164 = search.data[0]?.phone_number ?? "";
		await client.numberOrders.create({ phoneNumbers: [e164], customerReference: "test" });
		const [owned] = await client.phoneNumbers.list({ phoneNumber: e164 });
		const carrierRef = owned?.id ?? "";

		const numbers = numbersDouble({
			[NUMBER_ID]: { id: NUMBER_ID, e164, carrierProvider: "telnyx", carrierRef },
			[BYO_NUMBER_ID]: {
				id: BYO_NUMBER_ID,
				e164: "+13125550000",
				carrierProvider: null,
				carrierRef: null,
			},
		});
		const carrier = new CarrierService(env(), client, numbers, {} as unknown as TrunksService);
		return { carrier, carrierRef, e164 };
	}

	function unconfigured(): CarrierService {
		return new CarrierService(env(), undefined, numbersDouble({}), {} as unknown as TrunksService);
	}

	// -------------------------------------------------------------------------------------------
	// DTOs
	// -------------------------------------------------------------------------------------------

	describe("DTOs", () => {
		it("accepts a batch of E.164 numbers to port and rejects a bare national number", () => {
			expect(parseDto(createPortingOrderDto, { e164s: ["+13125551234"] }).e164s).to.have.length(1);
			expect(() => parseDto(createPortingOrderDto, { e164s: ["3125551234"] })).to.throw();
		});

		it("rejects an empty port and an unknown key rather than dropping either silently", () => {
			expect(() => parseDto(createPortingOrderDto, { e164s: [] })).to.throw();
			expect(() =>
				parseDto(createPortingOrderDto, { e164s: ["+13125551234"], bogus: true }),
			).to.throw();
		});

		/**
		 * The status filter is a free string on purpose: the enum exists so the UI can LABEL a status
		 * it received, not so this DTO can refuse one it has not heard of. A carrier adding a
		 * lifecycle state must not turn "show me my ports" into a 400.
		 */
		it("passes through a porting status it has never heard of", () => {
			expect(parseDto(listPortingOrdersDto, { status: "some-new-state" }).status).to.equal(
				"some-new-state",
			);
		});

		it("coerces the page numbers that arrive as query strings", () => {
			const parsed = parseDto(listPortingOrdersDto, { pageSize: "10", pageNumber: "2" });
			expect(parsed.pageSize).to.equal(10);
			expect(parsed.pageNumber).to.equal(2);
		});

		it("refuses a CNAM string past the NANP field width, and a non-ASCII one", () => {
			expect(parseDto(updateCnamListingDto, { details: "OPTIMIQ VOICE" }).details).to.equal(
				"OPTIMIQ VOICE",
			);
			expect(() => parseDto(updateCnamListingDto, { details: "SIXTEEN CHARS!!!" })).to.throw();
			expect(() => parseDto(updateCnamListingDto, { details: "CAFÉ" })).to.throw();
		});

		/** An empty PATCH is a request that means nothing; answering 200 to it would be a lie. */
		it("refuses a CNAM update that sets nothing", () => {
			expect(() => parseDto(updateCnamListingDto, {})).to.throw();
		});
	});

	// -------------------------------------------------------------------------------------------
	// Porting
	// -------------------------------------------------------------------------------------------

	describe("porting", () => {
		it("files a port and answers in the platform's vocabulary, not the carrier's", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			const result = await carrier.createPortingOrder(session(), { e164s: ["+13125551234"] });
			expect(result.data).to.have.length(1);
			const [order] = result.data;
			expect(order?.status).to.equal("draft");
			expect(order?.e164s).to.deep.equal(["+13125551234"]);
			expect(order?.supportKey).to.be.a("string");
			// No carrier field names crossed the seam.
			expect(order).to.not.have.property("support_key");
			expect(order).to.not.have.property("customer_reference");
		});

		/**
		 * The reason the create returns a list at all. A response that folded these into one order
		 * would silently drop the second, and the numbers in it would simply never port.
		 */
		it("returns every order when the carrier splits the request across losing carriers", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			const result = await carrier.createPortingOrder(session(), {
				e164s: ["+13125551234", "+442075550100"],
			});
			expect(result.data).to.have.length(2);
		});

		/**
		 * The point of `createPortingOrder` writing nothing: a ported number is not ours for weeks,
		 * and a `phone_number` row now would advertise a DID to the routing compiler and the
		 * `did-index` whose calls still land at the losing carrier.
		 */
		it("creates no phone_number row — a port in flight is not an owned DID", async () => {
			const client = createTelnyxClient({ apiKey: "KEY0123456789", baseUrl: fake.baseUrl });
			let created = 0;
			const numbers = {
				create: async () => {
					created += 1;
					return { data: {} };
				},
			} as unknown as PhoneNumbersService;
			const carrier = new CarrierService(env(), client, numbers, {} as unknown as TrunksService);
			await carrier.createPortingOrder(session(), { e164s: ["+13125551234"] });
			expect(created).to.equal(0);
		});

		it("lists only this organization's ports", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			await carrier.createPortingOrder(session(), { e164s: ["+13125551234"] });
			expect(
				(await carrier.listPortingOrders(session(), { pageSize: 25, pageNumber: 1 })).data,
			).to.have.length(1);
			// A different organization's session sees the same carrier account and none of its ports.
			const other = await carrier.listPortingOrders(session(OTHER_ORDER_ID), {
				pageSize: 25,
				pageNumber: 1,
			});
			expect(other.data).to.have.length(0);
		});

		it("reads one port's status back by id", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			const [filed] = (await carrier.createPortingOrder(session(), { e164s: ["+13125551234"] }))
				.data;
			const read = await carrier.getPortingOrder(session(), filed?.id ?? "");
			expect(read.data.id).to.equal(filed?.id);
			expect(read.data.status).to.equal("draft");
		});

		/**
		 * 404 rather than 403, deliberately: "that order exists but is not yours" lets any tenant
		 * enumerate the platform's ports one id at a time, and the phone numbers in them are the
		 * whole point of the enumeration.
		 */
		it("hides another organization's port behind a 404, not a 403", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			const [filed] = (await carrier.createPortingOrder(session(), { e164s: ["+13125551234"] }))
				.data;
			try {
				await carrier.getPortingOrder(session(OTHER_ORDER_ID), filed?.id ?? "");
				expect.fail("expected a not-found");
			} catch (error) {
				expect((error as { getStatus?: () => number }).getStatus?.()).to.equal(404);
			}
		});
	});

	// -------------------------------------------------------------------------------------------
	// CNAM
	// -------------------------------------------------------------------------------------------

	describe("CNAM", () => {
		it("round trips both halves of the listing", async () => {
			const { carrier, e164 } = await serviceWithOwnedNumber();
			const updated = await carrier.updateCnamListing(session(), NUMBER_ID, {
				enabled: true,
				listingEnabled: true,
				details: "OPTIMIQ VOICE",
			});
			expect(updated.data).to.deep.equal({
				phoneNumberId: NUMBER_ID,
				e164,
				enabled: true,
				listingEnabled: true,
				listingDetails: "OPTIMIQ VOICE",
			});
			expect((await carrier.getCnamListing(session(), NUMBER_ID)).data).to.deep.equal(updated.data);
		});

		it("reports both halves off for a number nobody has configured", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			const listing = (await carrier.getCnamListing(session(), NUMBER_ID)).data;
			expect(listing.enabled).to.equal(false);
			expect(listing.listingEnabled).to.equal(false);
		});

		/**
		 * A BYO or hand-entered DID has no `carrier_ref`, so there is nothing at Telnyx whose CNAM
		 * could change. Succeeding quietly would leave an admin believing they had set a caller-ID
		 * name that no switch anywhere will ever present.
		 */
		it("refuses a number the carrier does not manage, naming why", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			try {
				await carrier.updateCnamListing(session(), BYO_NUMBER_ID, { enabled: true });
				expect.fail("expected a refusal");
			} catch (error) {
				const response = (error as { getResponse?: () => Record<string, unknown> }).getResponse?.();
				expect(response?.code).to.equal("CARRIER_NUMBER_NOT_MANAGED");
				expect((error as { getStatus?: () => number }).getStatus?.()).to.equal(422);
			}
		});

		/**
		 * The tenant guard, from the outside: an id this organization cannot see never reaches the
		 * carrier, because the lookup that resolves it is organization-scoped.
		 */
		it("never builds a carrier request for an id this organization cannot see", async () => {
			const { carrier } = await serviceWithOwnedNumber();
			const before = fake.state.requests.length;
			try {
				await carrier.getCnamListing(session(), OTHER_ORDER_ID);
				expect.fail("expected a lookup failure");
			} catch {
				// The point is not the error type — the slice service owns that — but the silence.
			}
			expect(fake.state.requests.length).to.equal(before);
		});
	});

	// -------------------------------------------------------------------------------------------
	// The unconfigured deployment
	// -------------------------------------------------------------------------------------------

	/**
	 * Every developer machine and every CI runner is here, so this is the common case rather than
	 * the edge one. 503 with a code the UI can render, on every new endpoint, and nothing else.
	 */
	describe("without a carrier configured", () => {
		const cases: readonly (readonly [string, (service: CarrierService) => Promise<unknown>])[] = [
			["createPortingOrder", (s) => s.createPortingOrder(session(), { e164s: ["+13125551234"] })],
			["listPortingOrders", (s) => s.listPortingOrders(session(), { pageSize: 25, pageNumber: 1 })],
			["getPortingOrder", (s) => s.getPortingOrder(session(), OTHER_ORDER_ID)],
		];

		for (const [name, call] of cases) {
			it(`answers 503 CARRIER_NOT_CONFIGURED from ${name}`, async () => {
				try {
					await call(unconfigured());
					expect.fail("expected a 503");
				} catch (error) {
					const response = (
						error as { getResponse?: () => Record<string, unknown> }
					).getResponse?.();
					expect(response?.code).to.equal("CARRIER_NOT_CONFIGURED");
					expect((error as { getStatus?: () => number }).getStatus?.()).to.equal(503);
				}
			});
		}
	});
});
