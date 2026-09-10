import { describe, expect, it } from "bun:test";
import { cdrLegWriteDataSchema } from "@optimiq-voice/events";
import { isUuidV7EntityId } from "@optimiq-voice/identifiers";
import { attestationOf, authorizationOf, buildCdrLegWrite, dispositionFor } from "./cdr-leg";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const LEG = "0195c0f0-1c2f-7000-8000-0000000000e1";

function snapshot(overrides: Partial<ChannelSnapshot> = {}): ChannelSnapshot {
	return {
		channelId: LEG,
		callId: CALL,
		organizationId: ORG,
		direction: "inbound",
		state: "reporting",
		callState: "hangup",
		flags: [],
		profile: {
			callerIdNumber: "+15551234567",
			callerIdName: "Ada",
			destinationNumber: "+15559876543",
			context: "local-ctx",
		},
		variables: {},
		createdAt: 1_000_000,
		...overrides,
	};
}

describe("dispositionFor", () => {
	it("treats any answered leg as answered, whatever the cause says", () => {
		expect(dispositionFor({ answeredAt: 1, hangupCause: "USER_BUSY" })).toBe("answered");
		expect(dispositionFor({ answeredAt: 1, hangupCause: "NORMAL_CLEARING" })).toBe("answered");
	});

	it("classifies an unanswered busy", () => {
		expect(dispositionFor({ hangupCause: "USER_BUSY" })).toBe("busy");
	});

	it("classifies the ways a caller does not get an answer", () => {
		expect(dispositionFor({ hangupCause: "NO_ANSWER" })).toBe("no-answer");
		expect(dispositionFor({ hangupCause: "NO_USER_RESPONSE" })).toBe("no-answer");
		expect(dispositionFor({ hangupCause: "ORIGINATOR_CANCEL" })).toBe("no-answer");
		expect(dispositionFor({ hangupCause: "SUBSCRIBER_ABSENT" })).toBe("no-answer");
	});

	it("classifies a losing ring-all leg as no-answer, not as a failure", () => {
		expect(dispositionFor({ hangupCause: "LOSE_RACE" })).toBe("no-answer");
	});

	it("never files a leg that was never answered as answered", () => {
		// The four legs of one two-party fan-out: the loser the race cancelled, the leg the caller
		// gave up on, the one that rang out, and the one the edge cleared. None of them was answered,
		// and reading `NORMAL_CLEARING` as "the answer instant was lost" filed two of them as calls
		// somebody took.
		for (const cause of [
			"NORMAL_CLEARING",
			"LOSE_RACE",
			"ORIGINATOR_CANCEL",
			"NO_ANSWER",
		] as const) {
			expect(dispositionFor({ hangupCause: cause })).not.toBe("answered");
		}
		expect(dispositionFor({ hangupCause: "ATTENDED_TRANSFER" })).not.toBe("answered");
	});

	it("classifies a leg the race lost, and a caller who cancelled, as no-answer", () => {
		expect(dispositionFor({ hangupCause: "NORMAL_CLEARING" })).toBe("no-answer");
		expect(dispositionFor({ hangupCause: "ALLOTTED_TIMEOUT" })).toBe("no-answer");
		expect(dispositionFor({ hangupCause: "PICKED_OFF" })).toBe("no-answer");
	});

	it("classifies a refusal and everything else as failed", () => {
		expect(dispositionFor({ hangupCause: "CALL_REJECTED" })).toBe("failed");
		expect(dispositionFor({ hangupCause: "USER_NOT_REGISTERED" })).toBe("failed");
		expect(dispositionFor({ hangupCause: "GATEWAY_DOWN" })).toBe("failed");
		expect(dispositionFor({})).toBe("failed");
	});
});

describe("buildCdrLegWrite", () => {
	const base = {
		leg: "a",
		direction: "inbound",
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		hangupSide: "caller",
	} as const;

	it("produces a payload the wire contract accepts", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot({ answeredAt: 1_005_000, hangupAt: 1_065_000 }),
			endedAt: 1_065_000,
		});
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("mints a UUID v7 record id — the insert's idempotency key", () => {
		const data = buildCdrLegWrite({ ...base, snapshot: snapshot(), endedAt: 1_010_000 });
		expect(isUuidV7EntityId(data.id)).toBe(true);
	});

	it("reuses a persisted record id for a terminal retry", () => {
		const data = buildCdrLegWrite({
			...base,
			id: LEG,
			snapshot: snapshot(),
			endedAt: 1_010_000,
		});
		expect(data.id).toBe(LEG);
	});

	it("separates duration (what it cost the platform) from billsec (what it costs the tenant)", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot({ answeredAt: 1_005_000 }),
			endedAt: 1_065_000,
		});
		expect(data.durationMs).toBe(65_000);
		expect(data.billsecMs).toBe(60_000);
	});

	it("bills zero for a leg that rang and was never answered", () => {
		const data = buildCdrLegWrite({
			...base,
			hangupCause: "NO_ANSWER",
			hangupCauseCode: 19,
			snapshot: snapshot(),
			endedAt: 1_030_000,
		});
		expect(data.durationMs).toBe(30_000);
		expect(data.billsecMs).toBe(0);
		expect(data.answeredAt).toBeNull();
		expect(data.disposition).toBe("no-answer");
	});

	it("never produces a negative duration when the clock disagrees with itself", () => {
		const data = buildCdrLegWrite({ ...base, snapshot: snapshot(), endedAt: 1 });
		expect(data.durationMs).toBe(0);
		expect(data.billsecMs).toBe(0);
	});

	it("substitutes a marker for an anonymous caller rather than dropping the record", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot({
				profile: { destinationNumber: "+15559876543", context: "local-ctx" },
			}),
			endedAt: 1_010_000,
		});
		expect(data.fromNumber).toBe("unknown");
		expect(data.fromName).toBeNull();
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("does not carry the organization id — the subject and envelope already do", () => {
		const data = buildCdrLegWrite({ ...base, snapshot: snapshot(), endedAt: 1_010_000 });
		expect(Object.keys(data)).not.toContain("organizationId");
	});

	it("reports an honest unknown destination for a leg that was never routed", () => {
		const data = buildCdrLegWrite({ ...base, snapshot: snapshot(), endedAt: 1_010_000 });
		expect(data.destinationType).toBe("unknown");
		expect(data.destinationRef).toBeNull();
	});

	it("carries the destination the routing walk reached", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot(),
			endedAt: 1_010_000,
			destinationType: "extension",
			destinationRef: "0195c0f0-1c2f-7000-8000-0000000000f1",
		});

		expect(data.destinationType).toBe("extension");
		expect(data.destinationRef).toBe("0195c0f0-1c2f-7000-8000-0000000000f1");
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("accepts a kebab-case destination type, which is the compiler's vocabulary", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot(),
			endedAt: 1_010_000,
			destinationType: "ring-group",
			destinationRef: "0195c0f0-1c2f-7000-8000-0000000000f2",
		});

		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("reports a type with a null ref for a value-backed destination", () => {
		// An `external` node's "ref" is an E.164 string, and the column is a UUID.
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot(),
			endedAt: 1_010_000,
			destinationType: "external",
		});

		expect(data.destinationType).toBe("external");
		expect(data.destinationRef).toBeNull();
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("emits ISO-8601 instants", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot({ answeredAt: 1_005_000 }),
			endedAt: 1_065_000,
		});
		expect(data.startedAt).toBe(new Date(1_000_000).toISOString());
		expect(data.answeredAt).toBe(new Date(1_005_000).toISOString());
		expect(data.endedAt).toBe(new Date(1_065_000).toISOString());
	});
});

describe("attestationOf", () => {
	it("reads a full carrier claim off the leg's variables", () => {
		expect(
			attestationOf({
				OPTIMIQ_SIP_ATTESTATION: "A",
				OPTIMIQ_SIP_VERSTAT: "tn-validation-passed",
				OPTIMIQ_SIP_ORIGID: "de305d54-75b4-431b-adb2-eb6b9e546014",
			}),
		).toEqual({
			sipAttestation: "A",
			sipVerstat: "tn-validation-passed",
			sipOrigId: "de305d54-75b4-431b-adb2-eb6b9e546014",
		});
	});

	it("keeps a verstat stated without a level — it is the useful half", () => {
		expect(attestationOf({ OPTIMIQ_SIP_VERSTAT: "tn-validation-failed" })).toEqual({
			sipVerstat: "tn-validation-failed",
		});
	});

	it("drops a level outside the contract's vocabulary and keeps the rest", () => {
		expect(
			attestationOf({ OPTIMIQ_SIP_ATTESTATION: "D", OPTIMIQ_SIP_VERSTAT: "no-tn-validation" }),
		).toEqual({ sipVerstat: "no-tn-validation" });
	});

	it("reports nothing for a leg that carried no claim", () => {
		expect(attestationOf({})).toEqual({});
		expect(attestationOf({ OPTIMIQ_SIP_VERSTAT: "", OPTIMIQ_SIP_ORIGID: "" })).toEqual({});
	});

	it("truncates carrier-writable text rather than refusing it", () => {
		const long = "x".repeat(200);
		const read = attestationOf({ OPTIMIQ_SIP_VERSTAT: long, OPTIMIQ_SIP_ORIGID: long });
		expect(read.sipVerstat?.length).toBe(64);
		expect(read.sipOrigId?.length).toBe(128);
	});
});

describe("buildCdrLegWrite — the facts read back off the variables", () => {
	const base = {
		leg: "a",
		direction: "inbound",
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		hangupSide: "caller",
	} as const;

	it("lands the carrier's attestation on the ledger", () => {
		const variables = {
			OPTIMIQ_SIP_ATTESTATION: "B",
			OPTIMIQ_SIP_VERSTAT: "tn-validation-passed",
			OPTIMIQ_SIP_ORIGID: "carrier-origid",
		};
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot({ variables }),
			endedAt: 1_010_000,
			...attestationOf(variables),
		});

		expect(data.sipAttestation).toBe("B");
		expect(data.sipVerstat).toBe("tn-validation-passed");
		expect(data.sipOrigId).toBe("carrier-origid");
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("omits the attestation keys entirely on a leg that carried no claim", () => {
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot(),
			endedAt: 1_010_000,
			...attestationOf({}),
		});

		expect("sipAttestation" in data).toBe(false);
		expect("sipVerstat" in data).toBe(false);
		expect("sipOrigId" in data).toBe(false);
	});

	// Regression: `authorizationOf` was read at the call site and then dropped on the floor, because
	// `buildCdrLegWrite` never forwarded it. Every gated outbound call reported no authorisation.
	it("lands the authorisation code the walker recorded", () => {
		const variables = { OPTIMIQ_AUTH_PIN_ORDINAL: "3", OPTIMIQ_AUTH_PIN_LABEL: "night desk" };
		const data = buildCdrLegWrite({
			...base,
			snapshot: snapshot({ variables }),
			endedAt: 1_010_000,
			...authorizationOf(variables),
		});

		expect(data.authPinOrdinal).toBe(3);
		expect(data.authPinLabel).toBe("night desk");
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});
});

// Regression: `call_legs.sip_call_id` existed, was queried, and was 0-populated across every row on
// the stack — the payload had no such field at all, so no CDR could be correlated with a carrier's
// Call-ID in a traceback.
describe("buildCdrLegWrite — the SIP Call-ID", () => {
	const base = {
		snapshot: snapshot(),
		leg: "a" as const,
		direction: "inbound" as const,
		hangupCause: "NORMAL_CLEARING" as const,
		hangupCauseCode: 16,
		hangupSide: "caller" as const,
		endedAt: 1_010_000,
	};

	it("carries the dialog's Call-ID onto the payload", () => {
		const data = buildCdrLegWrite({ ...base, sipCallId: "3c26700d@carrier.example" });

		expect(data.sipCallId).toBe("3c26700d@carrier.example");
		expect(cdrLegWriteDataSchema.safeParse(data).success).toBe(true);
	});

	it("omits the key entirely on a leg with no dialog", () => {
		const data = buildCdrLegWrite(base);

		expect("sipCallId" in data).toBe(false);
	});
});
