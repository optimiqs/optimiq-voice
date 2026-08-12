import { describe, expect, it } from "bun:test";
import { ChannelAggregate } from "./channel-aggregate";
import { callIdForAriChannel, legIdForAriChannel } from "./channel-identity";
import { ChannelRegistry } from "./channel-registry";

/**
 * The live-channel index, and specifically the third of its three maps.
 *
 * The two id maps have been exercised by every orchestrator spec since P2. The SIP dialog map has
 * not, and it is the one with a way to go wrong quietly: it is filled in AFTER the entry is added,
 * from a value read off the media server, and it is the only index whose key can be re-pointed at a
 * different leg while both legs are alive. An index that kept a stale pointer would answer a desk
 * phone's REFER with a channel that no longer has the call on it, and one that failed to release a
 * key would grow for the lifetime of the process — neither shows up as a failing call, which is
 * exactly why they are asserted here rather than left to the integration suite.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";

function aggregate(ariChannelId: string, organizationId = ORG): ChannelAggregate {
	return ChannelAggregate.create({
		ariChannelId,
		channelId: legIdForAriChannel(ariChannelId),
		callId: callIdForAriChannel(ariChannelId),
		organizationId,
		direction: "inbound",
		leg: "a",
		profile: { destinationNumber: "1001", context: "default", source: "ari" },
		createdAt: 0,
	});
}

describe("the sip dialog index", () => {
	it("finds the leg carrying a Call-ID, and nothing for one it has never seen", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);
		registry.indexSipDialog(leg, "3c26700c1adf-6qgy0fkn7cvb");

		expect(registry.bySipCallId("3c26700c1adf-6qgy0fkn7cvb")).toBe(leg);
		expect(registry.bySipCallId("nobody@1.2.3.4")).toBeUndefined();
	});

	it("matches the Call-ID byte for byte, because RFC 3261 §20.8 makes it case-sensitive", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);
		registry.indexSipDialog(leg, "AbC@1.2.3.4");

		expect(registry.bySipCallId("AbC@1.2.3.4")).toBe(leg);
		expect(registry.bySipCallId("abc@1.2.3.4")).toBeUndefined();
	});

	it("trims what a dialplan Set() padded, in both directions", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);
		registry.indexSipDialog(leg, "  abc@1.2.3.4  ");

		expect(registry.bySipCallId("abc@1.2.3.4")).toBe(leg);
		expect(registry.bySipCallId("  abc@1.2.3.4 ")).toBe(leg);
	});

	it("stores nothing for a value that could never be a key", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);

		registry.indexSipDialog(leg, "   ");
		// Above `sipTransferRequestSchema`'s ceiling, so no request could ever name it.
		registry.indexSipDialog(leg, "x".repeat(257));

		expect(registry.sipDialogCount).toBe(0);
	});

	it("is idempotent — a re-delivered arrival must not double-count anything", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);
		registry.indexSipDialog(leg, "abc@1.2.3.4");
		registry.indexSipDialog(leg, "abc@1.2.3.4");

		expect(registry.sipDialogCount).toBe(1);
		registry.remove(leg);
		expect(registry.sipDialogCount).toBe(0);
	});
});

describe("the sip dialog index, when a dialog moves", () => {
	it("releases the old key when one leg re-indexes under a new Call-ID", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);
		registry.indexSipDialog(leg, "first@1.2.3.4");
		registry.indexSipDialog(leg, "second@1.2.3.4");

		expect(registry.bySipCallId("first@1.2.3.4")).toBeUndefined();
		expect(registry.bySipCallId("second@1.2.3.4")).toBe(leg);
		expect(registry.sipDialogCount).toBe(1);
	});

	/**
	 * The masquerade case. An attended transfer completing, or a pickup, moves a SIP dialog from one
	 * media channel to another while both are alive — and the loser must not be able to un-index the
	 * winner on the way out.
	 */
	it("hands a Call-ID to the second leg that claims it, and survives the first one's teardown", () => {
		const registry = new ChannelRegistry();
		const first = aggregate("1754400000.42");
		const second = aggregate("1754400000.43");
		registry.add(first);
		registry.add(second);
		registry.indexSipDialog(first, "abc@1.2.3.4");
		registry.indexSipDialog(second, "abc@1.2.3.4");

		expect(registry.bySipCallId("abc@1.2.3.4")).toBe(second);

		registry.remove(first);
		expect(registry.bySipCallId("abc@1.2.3.4")).toBe(second);

		registry.remove(second);
		expect(registry.bySipCallId("abc@1.2.3.4")).toBeUndefined();
		expect(registry.sipDialogCount).toBe(0);
	});
});

describe("the sip dialog index, on teardown", () => {
	it("leaks nothing across a thousand calls that came and went", () => {
		const registry = new ChannelRegistry();
		for (let call = 0; call < 1_000; call += 1) {
			const leg = aggregate(`1754400000.${String(call)}`);
			registry.add(leg);
			registry.indexSipDialog(leg, `call-${String(call)}@1.2.3.4`);
			registry.remove(leg);
		}

		expect(registry.size).toBe(0);
		expect(registry.sipDialogCount).toBe(0);
		expect(registry.bySipCallId("call-500@1.2.3.4")).toBeUndefined();
	});

	it("removes a leg that was never indexed without disturbing the ones that were", () => {
		const registry = new ChannelRegistry();
		const indexed = aggregate("1754400000.42");
		// A Local half or a snoop: real, tracked, and carrying no SIP dialog at all.
		const dialogless = aggregate("1754400000.43");
		registry.add(indexed);
		registry.add(dialogless);
		registry.indexSipDialog(indexed, "abc@1.2.3.4");

		registry.remove(dialogless);

		expect(registry.bySipCallId("abc@1.2.3.4")).toBe(indexed);
		expect(registry.sipDialogCount).toBe(1);
	});

	it("drops every dialog when the registry is cleared", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.42");
		registry.add(leg);
		registry.indexSipDialog(leg, "abc@1.2.3.4");

		registry.clear();

		expect(registry.sipDialogCount).toBe(0);
		expect(registry.bySipCallId("abc@1.2.3.4")).toBeUndefined();

		// And the reverse map went with it: re-adding the same leg starts from nothing.
		registry.add(leg);
		registry.remove(leg);
		expect(registry.sipDialogCount).toBe(0);
	});
});

/**
 * The per-organization count, which is the fourth map and the one on the CALL SETUP PATH.
 *
 * The admission gate asks this question about every arriving call, so it has to be a counter rather
 * than a filter over `all` — which allocates a copy of every live leg on the instance before the
 * filter starts. What is asserted here is the arithmetic and, more importantly, that the map does
 * not LEAK: a tenant whose calls have all ended must leave no key behind, or the map grows to one
 * entry per organization the process has ever served and never shrinks.
 */
describe("the per-organization count", () => {
	it("counts only this organization's legs", () => {
		const registry = new ChannelRegistry();
		registry.add(aggregate("1754400000.1"));
		registry.add(aggregate("1754400000.2"));
		registry.add(aggregate("1754400000.3", OTHER_ORG));

		expect(registry.liveCountFor(ORG)).toBe(2);
		expect(registry.liveCountFor(OTHER_ORG)).toBe(1);
	});

	/** An organization this process has never served is zero, not undefined. */
	it("answers zero for an organization it holds nothing for", () => {
		expect(new ChannelRegistry().liveCountFor(ORG)).toBe(0);
	});

	it("gives a slot back when a leg ends", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.1");
		registry.add(leg);
		registry.add(aggregate("1754400000.2"));
		registry.remove(leg);

		expect(registry.liveCountFor(ORG)).toBe(1);
	});

	/** The leak check: the last leg leaving must drop the key, not leave an empty set behind. */
	it("keeps no entry for an organization whose calls have all ended", () => {
		const registry = new ChannelRegistry();
		const leg = aggregate("1754400000.1");
		registry.add(leg);
		registry.remove(leg);

		expect(registry.liveCountFor(ORG)).toBe(0);
		// Adding and removing repeatedly must not accumulate, which is what the count proves for the
		// one organization and what `clear` proves for all of them.
		registry.add(aggregate("1754400000.2"));
		registry.clear();
		expect(registry.liveCountFor(ORG)).toBe(0);
	});
});
