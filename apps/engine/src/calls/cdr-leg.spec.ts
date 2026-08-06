import { describe, expect, it } from "bun:test";
import { cdrLegWriteDataSchema } from "@optimiq-voice/events";
import { isUuidV7EntityId } from "@optimiq-voice/identifiers";
import { buildCdrLegWrite, dispositionFor } from "./cdr-leg";
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

	it("recovers an answered leg whose answer instant was lost", () => {
		// `ATTENDED_TRANSFER` is only reachable after answer, so the media path existed.
		expect(dispositionFor({ hangupCause: "ATTENDED_TRANSFER" })).toBe("answered");
	});

	it("classifies everything else as failed", () => {
		expect(dispositionFor({ hangupCause: "CALL_REJECTED" })).toBe("failed");
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
