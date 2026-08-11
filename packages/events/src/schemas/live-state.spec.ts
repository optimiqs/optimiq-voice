import { describe, expect, it } from "bun:test";
import { CHANNELS_KV, kvKeyFor, PRESENCE_KV, REGISTRATIONS_KV } from "../streams";
import {
	extensionPresenceSchema,
	isLiveChannel,
	isRegistrationLapsed,
	LIVE_CHANNEL_TEARDOWN_STATES,
	liveChannelSchema,
	PRESENCE_DEVICE_STATES,
	registrationBindingSchema,
} from "./live-state";

/**
 * The live-state KV value contracts.
 *
 * What is worth asserting here is the TOLERANCE, not the strictness: these values cross a language
 * border and a release boundary, and the reader's job is to keep working when the writer learns a
 * new field. The strict half — the fields a reader acts on — is asserted by rejecting the values
 * that would make a wallboard state something untrue.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		orgId: ORG,
		aor: "sip:1001@acme.example.com",
		aorHash: "9f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d",
		contact: "sip:1001@192.168.1.44:5060;transport=udp",
		transport: "udp",
		registeredAt: "2026-08-06T09:00:00.000Z",
		expiresAt: "2026-08-06T09:05:00.000Z",
		expiresInSeconds: 300,
		...overrides,
	};
}

function channel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		channelId: "PJSIP/1001-00000001",
		callId: "0195c0f0-1c2f-7000-8000-0000000000c1",
		organizationId: ORG,
		direction: "inbound",
		state: "executing",
		flags: ["answered"],
		createdAt: 1_785_000_000_000,
		...overrides,
	};
}

describe("registrationBindingSchema", () => {
	it("accepts a binding sipd would write", () => {
		expect(registrationBindingSchema.safeParse(binding()).success).toBe(true);
	});

	/**
	 * The forward-compatibility contract. `sipd` ships on its own cadence, and a reader that
	 * rejected an entry for carrying a field it had not heard of would turn every additive Go
	 * release into a blank registrations panel.
	 */
	it("passes a field it has never heard of straight through", () => {
		const parsed = registrationBindingSchema.parse(binding({ pathHeader: "sip:edge;lr" }));
		expect((parsed as Record<string, unknown>).pathHeader).toBe("sip:edge;lr");
	});

	it("refuses a binding with no contact to send anything to", () => {
		expect(registrationBindingSchema.safeParse(binding({ contact: "" })).success).toBe(false);
	});

	it("refuses a transport outside the vocabulary the edge accepts", () => {
		expect(registrationBindingSchema.safeParse(binding({ transport: "sctp" })).success).toBe(false);
	});

	/**
	 * The bucket's TTL is an hour and a device's `Expires:` is minutes, so an entry can be present
	 * and long dead. A panel that reads presence as "registered" shows an unplugged phone as online
	 * for the rest of the hour.
	 */
	it("reads a present-but-lapsed binding as lapsed", () => {
		const parsed = registrationBindingSchema.parse(binding());
		expect(isRegistrationLapsed(parsed, Date.parse("2026-08-06T09:04:00.000Z"))).toBe(false);
		expect(isRegistrationLapsed(parsed, Date.parse("2026-08-06T09:05:00.000Z"))).toBe(true);
	});

	it("treats an unreadable expiry as lapsed rather than as forever", () => {
		const parsed = registrationBindingSchema.parse(
			binding({ expiresAt: "2026-08-06T09:05:00.000Z" }),
		);
		expect(isRegistrationLapsed({ ...parsed, expiresAt: "not a date" }, Date.now())).toBe(true);
	});

	it("is the value shape of the bucket it names", () => {
		expect(REGISTRATIONS_KV.name).toBe("registrations");
	});
});

describe("liveChannelSchema", () => {
	it("accepts a snapshot the engine would write", () => {
		expect(liveChannelSchema.safeParse(channel()).success).toBe(true);
	});

	/**
	 * `ChannelSnapshot` carries variables, a caller profile with a routing context, and a bridge id.
	 * A wallboard reads four of those fields; the rest must survive being parsed by something that
	 * does not know what they are.
	 */
	it("keeps the fields a wallboard does not read", () => {
		const parsed = liveChannelSchema.parse(
			channel({
				variables: { OPTIMIQ_ORG_ID: ORG },
				profile: { destinationNumber: "1001", context: "optimiq-inbound" },
			}),
		);
		expect((parsed as Record<string, unknown>).variables).toEqual({ OPTIMIQ_ORG_ID: ORG });
		expect((parsed.profile as Record<string, unknown> | undefined)?.context).toBe(
			"optimiq-inbound",
		);
	});

	it("defaults an absent flag list rather than making every reader branch on undefined", () => {
		const parsed = liveChannelSchema.parse(channel({ flags: undefined }));
		expect(parsed.flags).toEqual([]);
	});

	it("refuses a direction the channel machine does not have", () => {
		expect(liveChannelSchema.safeParse(channel({ direction: "internal" })).success).toBe(false);
	});

	/**
	 * Epoch millis, not ISO. This is `ChannelSnapshot`'s existing shape — chosen so the value
	 * survives `JSON.parse` without a reviver on the engine's hottest path — and re-encoding it at
	 * the border would mean the bucket held one thing and this contract described another.
	 */
	it("keeps timestamps as epoch millis", () => {
		expect(
			liveChannelSchema.safeParse(channel({ createdAt: "2026-08-06T09:00:00Z" })).success,
		).toBe(false);
	});

	it("counts a leg in teardown as gone, whichever half of the write landed first", () => {
		for (const state of LIVE_CHANNEL_TEARDOWN_STATES) {
			expect(isLiveChannel(liveChannelSchema.parse(channel({ state })))).toBe(false);
		}
		expect(
			isLiveChannel(liveChannelSchema.parse(channel({ state: "executing", hangupAt: 1 }))),
		).toBe(false);
		expect(isLiveChannel(liveChannelSchema.parse(channel()))).toBe(true);
	});

	it("is the value shape of the bucket it names", () => {
		expect(CHANNELS_KV.name).toBe("channels");
	});
});

describe("extensionPresenceSchema", () => {
	const NOW = 1_785_000_000_000;

	function presence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			orgId: ORG,
			extensionNumber: "1001",
			state: "ringing",
			channelCount: 1,
			callStates: ["ringing"],
			updatedAt: NOW,
			...overrides,
		};
	}

	it("accepts a value the engine would write", () => {
		expect(extensionPresenceSchema.safeParse(presence()).success).toBe(true);
	});

	/**
	 * The one closed vocabulary among the KV value contracts. `sipd` maps it onto RFC 4235
	 * `dialog-info+xml`, and a mapper has no way to degrade an unknown value — the failure would be a
	 * NOTIFY it cannot compose, so a lamp stuck on whatever it last showed.
	 */
	it("refuses a device state outside the vocabulary", () => {
		expect(extensionPresenceSchema.safeParse(presence({ state: "dnd" })).success).toBe(false);
		for (const state of PRESENCE_DEVICE_STATES) {
			expect(extensionPresenceSchema.safeParse(presence({ state })).success).toBe(true);
		}
	});

	it("keys by the dialable number, which is what a BLF key is provisioned against", () => {
		const parsed = extensionPresenceSchema.parse(presence());
		expect(kvKeyFor.presence(parsed.orgId, parsed.extensionNumber)).toBe(`${ORG}.1001`);
	});

	/** `.loose()`, like every other KV contract here — a writer may learn a field first. */
	it("keeps a field this reader has not heard of", () => {
		const parsed = extensionPresenceSchema.parse(presence({ dndUntil: NOW + 1000 }));
		expect((parsed as Record<string, unknown>).dndUntil).toBe(NOW + 1000);
	});

	it("is the value shape of the bucket it names", () => {
		expect(PRESENCE_KV.name).toBe("presence");
	});
});
