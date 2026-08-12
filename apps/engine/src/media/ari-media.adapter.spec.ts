import { describe, expect, it } from "bun:test";
import { AriMediaAdapter } from "./ari-media.adapter";
import type { TapRequest } from "./media-port";
import type { AriClient } from "@optimiq-voice/media-ari";

/**
 * The one translation in the ARI driver that is worth a spec of its own: SIDES to DIRECTIONS.
 *
 * ## Why only this
 *
 * Almost everything in `AriMediaAdapter` is a one-line forward — `answer` calls `answer` — and a
 * spec for those would assert that a method calls the method it is named after. `tap` is the
 * exception, because it is the only place in the engine where a domain concept is turned into a
 * different concept with an INVERSION in the middle:
 *
 * ```text
 * hear the target party      spy "in"        (what they say)
 * hear the other party       spy "out"       (what they are being sent)
 * speak to the target party  whisper "out"   (inject into what they hear)
 * speak to the other party   whisper "in"    (inject into what they send onward)
 * ```
 *
 * The two axes map opposite ways round, so a helper that "simplified" them into one would be right
 * on half the table and silently wrong on the other half — and the wrong half puts a supervisor's
 * coaching into a customer's ear. This is exactly the shape of bug that no end-to-end test catches,
 * because both directions produce a working tap.
 *
 * ## Why a fake client rather than a harness
 *
 * The whole surface `tap` and `stopTap` touch is five functions. A fake with five functions is not a
 * harness, it is an argument recorder — and everything that would need a harness (the event stream,
 * the HTTP client, the reconnect) is `packages/media-ari`'s own subject and is tested there.
 */

interface Recorded {
	readonly method: string;
	readonly args: readonly unknown[];
}

function fakeAri(calls: Recorded[]): AriClient {
	const record =
		(method: string) =>
		async (...args: unknown[]): Promise<unknown> => {
			calls.push({ method, args });
			return {};
		};
	return {
		channels: { snoop: record("snoop"), hangup: record("hangup") },
		bridges: {
			create: record("create"),
			addChannels: record("addChannels"),
			destroy: record("destroy"),
		},
	} as unknown as AriClient;
}

function tapRequest(overrides: Partial<TapRequest> = {}): TapRequest {
	return {
		tapId: "tap-1",
		targetChannelId: "agent-channel",
		targetSide: "b",
		supervisorChannelId: "supervisor-channel",
		tapChannelId: "tap-channel",
		bridgeId: "tap-bridge",
		application: "optimiq-engine",
		hear: "both",
		speakTo: "none",
		...overrides,
	};
}

/** The `snoop` options the adapter produced, which is the whole assertion. */
async function snoopOptionsFor(
	overrides: Partial<TapRequest>,
): Promise<{ readonly spy: string; readonly whisper: string }> {
	const calls: Recorded[] = [];
	const adapter = new AriMediaAdapter(fakeAri(calls), "optimiq-engine");
	await adapter.tap(tapRequest(overrides));
	const snoop = calls.find((call) => call.method === "snoop");
	return snoop?.args[1] as { spy: string; whisper: string };
}

describe("AriMediaAdapter.tap — hearing", () => {
	it("hears BOTH parties as spy both, which is what all three features ask for", async () => {
		expect((await snoopOptionsFor({ hear: "both" })).spy).toBe("both");
	});

	it("hears the MONITORED party through the direction they speak into", async () => {
		// `in` is audio coming FROM the party on the snooped channel.
		expect((await snoopOptionsFor({ hear: "b", targetSide: "b" })).spy).toBe("in");
		expect((await snoopOptionsFor({ hear: "a", targetSide: "a" })).spy).toBe("in");
	});

	it("hears the OTHER party through the direction being sent to the monitored one", async () => {
		expect((await snoopOptionsFor({ hear: "a", targetSide: "b" })).spy).toBe("out");
		expect((await snoopOptionsFor({ hear: "b", targetSide: "a" })).spy).toBe("out");
	});
});

describe("AriMediaAdapter.tap — speaking", () => {
	it("says nothing at all for an eavesdrop", async () => {
		expect((await snoopOptionsFor({ speakTo: "none" })).whisper).toBe("none");
	});

	it("INVERTS the hearing map: speaking to the monitored party is whisper OUT", async () => {
		// The inversion this spec exists for. Reusing the `hear` mapping here would produce `in`, which
		// injects the supervisor's voice into what the monitored party is SENDING — i.e. straight into
		// the customer's ear, which is the worst outcome this feature has.
		expect((await snoopOptionsFor({ speakTo: "b", targetSide: "b" })).whisper).toBe("out");
		expect((await snoopOptionsFor({ speakTo: "a", targetSide: "a" })).whisper).toBe("out");
	});

	it("speaks to the OTHER party through the direction the monitored one sends onward", async () => {
		expect((await snoopOptionsFor({ speakTo: "a", targetSide: "b" })).whisper).toBe("in");
		expect((await snoopOptionsFor({ speakTo: "b", targetSide: "a" })).whisper).toBe("in");
	});

	it("speaks to everybody for a barge", async () => {
		expect((await snoopOptionsFor({ speakTo: "both" })).whisper).toBe("both");
	});
});

describe("AriMediaAdapter.tap — the bridge", () => {
	it("snoops the TARGET and bridges the tap to the SUPERVISOR, in that order", async () => {
		const calls: Recorded[] = [];
		const adapter = new AriMediaAdapter(fakeAri(calls), "optimiq-engine");
		const handle = await adapter.tap(tapRequest());

		expect(calls.map((call) => call.method)).toEqual(["snoop", "create", "addChannels"]);
		expect(calls[0]?.args[0]).toBe("agent-channel");
		// Client-assigned throughout: the tap enters the engine's own application, so the orchestrator
		// has to be able to recognise the id before the channel exists.
		expect(calls[0]?.args[1]).toMatchObject({ snoopId: "tap-channel", app: "optimiq-engine" });
		expect(calls[1]?.args[0]).toMatchObject({ bridgeId: "tap-bridge", name: "tap-tap-1" });
		// The tap and the supervisor's leg, and NOBODY from the monitored conversation.
		expect(calls[2]?.args).toEqual(["tap-bridge", ["tap-channel", "supervisor-channel"]]);

		expect(handle).toEqual({
			tapId: "tap-1",
			tapChannelId: "tap-channel",
			bridgeId: "tap-bridge",
		});
	});

	it("takes the bridge and the tap channel down and touches nothing else", async () => {
		// The invariant: stopping a tap must never end the call being monitored. The monitored legs
		// were never in this bridge, so destroying it cannot reach them — and nothing here names them.
		const calls: Recorded[] = [];
		const adapter = new AriMediaAdapter(fakeAri(calls), "optimiq-engine");
		await adapter.stopTap({ tapId: "tap-1", tapChannelId: "tap-channel", bridgeId: "tap-bridge" });

		expect(calls.map((call) => call.method)).toEqual(["destroy", "hangup"]);
		expect(calls[0]?.args[0]).toBe("tap-bridge");
		expect(calls[1]?.args[0]).toBe("tap-channel");
	});
});
