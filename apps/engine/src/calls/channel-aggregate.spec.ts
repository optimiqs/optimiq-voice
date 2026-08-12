import { describe, expect, it } from "bun:test";
import { InvalidChannelTransitionError } from "@optimiq-voice/telephony";
import { ChannelAggregate } from "./channel-aggregate";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const LEG = "0195c0f0-1c2f-7000-8000-0000000000e1";

function makeAggregate(
	direction: "inbound" | "outbound" | "internal" = "inbound",
): ChannelAggregate {
	return ChannelAggregate.create({
		ariChannelId: "1754400000.1",
		channelId: LEG,
		callId: CALL,
		organizationId: ORG,
		direction,
		leg: "a",
		profile: { destinationNumber: "+15559876543", context: "local-ctx" },
		createdAt: 1_000,
	});
}

describe("ChannelAggregate.create", () => {
	it("starts in the initial state of both machines", () => {
		const aggregate = makeAggregate();
		expect(aggregate.state).toBe("created");
		expect(aggregate.callState).toBe("down");
		expect(aggregate.isTearingDown).toBe(false);
		expect(aggregate.isAnswered).toBe(false);
	});

	it("keeps the media id only in the reserved recovery variable", () => {
		const aggregate = makeAggregate();
		expect(aggregate.ariChannelId).toBe("1754400000.1");
		expect(aggregate.snapshot.variables.OPTIMIQ_MEDIA_CHANNEL_ID).toBe("1754400000.1");
		expect(aggregate.snapshot.profile).not.toHaveProperty("mediaChannelId");
	});

	it("hydrates the media identity and terminal initiator from a KV snapshot", () => {
		const original = makeAggregate();
		original.markHangup({ cause: "NORMAL_CLEARING", at: 2_000, initiatedByEngine: true });
		original.transitionTo("hangup");
		original.transitionTo("reporting");

		const hydrated = ChannelAggregate.hydrate(
			JSON.parse(JSON.stringify(original.snapshot)) as typeof original.snapshot,
		);

		expect(hydrated.ariChannelId).toBe(original.ariChannelId);
		expect(hydrated.state).toBe("reporting");
		expect(hydrated.wasHungUpByEngine).toBe(true);
	});

	it("maps an internal call onto the inbound signalling direction", () => {
		expect(makeAggregate("internal").snapshot.direction).toBe("inbound");
		expect(makeAggregate("outbound").snapshot.direction).toBe("outbound");
	});

	it("flags an originated leg as outbound", () => {
		expect(makeAggregate("outbound").snapshot.flags).toContain("outbound");
		expect(makeAggregate("inbound").snapshot.flags).toEqual([]);
	});
});

describe("state transitions", () => {
	it("walks the inbound lifecycle", () => {
		const aggregate = makeAggregate();
		aggregate.transitionTo("initializing");
		aggregate.transitionTo("routing");
		aggregate.transitionTo("executing");
		expect(aggregate.state).toBe("executing");
	});

	it("throws on an edge the machine does not have — guard, then execute", () => {
		const aggregate = makeAggregate();
		expect(() => aggregate.transitionTo("exchanging-media")).toThrow(InvalidChannelTransitionError);
		// The write never happened.
		expect(aggregate.state).toBe("created");
	});

	it("reports a no-op transition rather than throwing on a redelivered event", () => {
		const aggregate = makeAggregate();
		expect(aggregate.tryTransitionTo("created")).toBe(false);
		expect(aggregate.tryTransitionTo("initializing")).toBe(true);
		expect(aggregate.tryTransitionTo("exchanging-media")).toBe(false);
		expect(aggregate.state).toBe("initializing");
	});

	it("treats the teardown tail as one-way", () => {
		const aggregate = makeAggregate();
		aggregate.transitionTo("hangup");
		expect(aggregate.isTearingDown).toBe(true);
		aggregate.transitionTo("reporting");
		aggregate.transitionTo("destroyed");
		expect(() => aggregate.transitionTo("executing")).toThrow(InvalidChannelTransitionError);
	});
});

describe("call state", () => {
	it("moves along valid edges and reports whether it moved", () => {
		const aggregate = makeAggregate();
		expect(aggregate.tryCallStateTo("ringing")).toBe(true);
		expect(aggregate.tryCallStateTo("ringing")).toBe(false);
		expect(aggregate.tryCallStateTo("active")).toBe(true);
		expect(aggregate.callState).toBe("active");
	});

	it("drops an impossible edge instead of throwing, because ARI reports out of order", () => {
		const aggregate = makeAggregate();
		aggregate.tryCallStateTo("active");
		// `active -> ringing` does not exist; a late ARI event must not blow up the handler.
		expect(aggregate.tryCallStateTo("ringing")).toBe(false);
		expect(aggregate.callState).toBe("active");
	});
});

describe("markAnswered", () => {
	it("records the instant and the flag once", () => {
		const aggregate = makeAggregate();
		expect(aggregate.markAnswered(2_000)).toBe(true);
		expect(aggregate.markAnswered(9_000)).toBe(false);
		expect(aggregate.snapshot.answeredAt).toBe(2_000);
		expect(aggregate.snapshot.flags).toContain("answered");
		expect(aggregate.isAnswered).toBe(true);
	});
});

describe("markHangup", () => {
	it("fixes the cause on the first call", () => {
		const aggregate = makeAggregate();
		expect(aggregate.markHangup({ cause: "USER_BUSY", at: 3_000, initiatedByEngine: false })).toBe(
			true,
		);
		expect(aggregate.hangupCause).toBe("USER_BUSY");
		expect(aggregate.hangupCauseCode).toBe(17);
		expect(aggregate.snapshot.hangupAt).toBe(3_000);
	});

	it("refuses to overwrite the cause — the CDR must be reproducible from the events", () => {
		const aggregate = makeAggregate();
		aggregate.markHangup({ cause: "USER_BUSY", at: 3_000, initiatedByEngine: false });
		expect(
			aggregate.markHangup({ cause: "NORMAL_CLEARING", at: 4_000, initiatedByEngine: true }),
		).toBe(false);
		expect(aggregate.hangupCause).toBe("USER_BUSY");
		expect(aggregate.snapshot.hangupAt).toBe(3_000);
		expect(aggregate.wasHungUpByEngine).toBe(false);
	});

	it("reports zero when no cause has been recorded", () => {
		expect(makeAggregate().hangupCauseCode).toBe(0);
	});
});

describe("flags and variables", () => {
	it("treats flags as a set", () => {
		const aggregate = makeAggregate();
		aggregate.addFlag("hold");
		aggregate.addFlag("hold");
		expect(aggregate.snapshot.flags.filter((flag) => flag === "hold")).toHaveLength(1);
		aggregate.removeFlag("hold");
		aggregate.removeFlag("hold");
		expect(aggregate.snapshot.flags).not.toContain("hold");
	});

	it("accumulates channel variables", () => {
		const aggregate = makeAggregate();
		aggregate.setVariable("OPTIMIQ_ORG_ID", ORG);
		aggregate.setVariable("OPTIMIQ_CALL_DIRECTION", "inbound");
		expect(aggregate.snapshot.variables).toEqual({
			OPTIMIQ_ORG_ID: ORG,
			OPTIMIQ_CALL_DIRECTION: "inbound",
			OPTIMIQ_MEDIA_CHANNEL_ID: "1754400000.1",
		});
	});

	it("associates and clears a bridge", () => {
		const aggregate = makeAggregate();
		aggregate.setBridge("bridge-1");
		expect(aggregate.snapshot.bridgeId).toBe("bridge-1");
		aggregate.setBridge(undefined);
		expect(aggregate.snapshot.bridgeId).toBeUndefined();
	});

	it("forgets a variable outright rather than blanking it", () => {
		const aggregate = makeAggregate();
		aggregate.setVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID", "leg-2");
		aggregate.clearVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID");
		// An empty string would be read as a leg id by the teardown path; the key has to be gone.
		expect("OPTIMIQ_BRIDGE_PEER_LEG_ID" in aggregate.snapshot.variables).toBe(false);
		expect(() => {
			aggregate.clearVariable("NEVER_SET");
		}).not.toThrow();
	});
});

describe("detaching from a routing walk", () => {
	it("starts attached and is one-way once a feature takes the leg over", () => {
		const aggregate = makeAggregate();
		expect(aggregate.isDetached).toBe(false);
		aggregate.detach();
		aggregate.detach();
		expect(aggregate.isDetached).toBe(true);
	});

	it("is NOT a teardown — the leg is alive, it is the walk that is over", () => {
		const aggregate = makeAggregate();
		aggregate.detach();
		expect(aggregate.isTearingDown).toBe(false);
		expect(aggregate.snapshot.hangupCause).toBeUndefined();
	});
});

describe("the snapshot", () => {
	it("survives a JSON round trip, because that is what KV stores", () => {
		const aggregate = makeAggregate();
		aggregate.transitionTo("initializing");
		aggregate.markAnswered(5_000);
		aggregate.setVariable("OPTIMIQ_ORG_ID", ORG);

		const roundTripped = JSON.parse(JSON.stringify(aggregate.snapshot)) as unknown;
		expect(roundTripped).toEqual(aggregate.snapshot);
	});
});
