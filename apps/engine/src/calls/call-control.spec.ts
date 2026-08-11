import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../ari/media-port.fake";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "../routing/call-signals";
import { ParkRegistry } from "../routing/park-registry";
import { CallControl, pickupGroupFilter } from "./call-control";
import type { FakeMediaPortOptions } from "../ari/media-port.fake";
import type {
	CallControlHost,
	ControlledLeg,
	ParkLot,
	PickupCandidate,
	RouteOutcome,
	RouteRequest,
} from "./call-control";
import type { CallEvent } from "@optimiq-voice/events";
import type { CallState, ChannelFlag, ChannelState, HangupCause } from "@optimiq-voice/telephony";

/**
 * Settles the microtask queue.
 *
 * A fixed number of `await Promise.resolve()` calls used to be enough; a park or conference claim
 * that may be shared adds asynchronous steps to paths that were synchronous, and a spec that
 * hard-codes the tick count breaks every time one is added. Draining until nothing is left pending
 * is the assertion these specs actually mean.
 */
async function flush(ticks = 12): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await Promise.resolve();
	}
}

/**
 * Call-control specs, driven entirely by fakes.
 *
 * The media server, the leg registry, the router and the event publisher are all ports, so a
 * complete attended transfer — hold the transferee, consult a target, join them, drop the
 * transferor — runs in process with no Asterisk and no NATS.
 *
 * The one thing these specs do NOT fake is the park registry: its exclusion invariant is the whole
 * point of parking, and a fake that handed out slots without enforcing it would let every retrieval
 * test pass on a registry that was broken.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const LOT: ParkLot = {
	parkLotId: "0195c0f0-1c2f-7000-8000-0000000000f1",
	slotStart: 401,
	slotEnd: 402,
	timeoutSeconds: 60,
};

interface FakeLeg extends ControlledLeg {
	bridgeId: string | undefined;
	peerMediaChannelId: string | undefined;
	isTearingDown: boolean;
	isAnswered: boolean;
	readonly flags: Set<ChannelFlag>;
	readonly channelStates: ChannelState[];
	readonly callStates: CallState[];
	readonly bridgePeers: (string | undefined)[];
	hangupCause: HangupCause | undefined;
	detached: boolean;
}

function fakeLeg(id: string, overrides: Partial<FakeLeg> = {}): FakeLeg {
	const leg: FakeLeg = {
		mediaChannelId: id,
		legId: `leg-${id}`,
		callId: `call-${id}`,
		organizationId: ORG,
		isTearingDown: false,
		isAnswered: true,
		bridgeId: undefined,
		peerMediaChannelId: undefined,
		callerIdNumber: `n-${id}`,
		flags: new Set<ChannelFlag>(),
		channelStates: [],
		callStates: [],
		bridgePeers: [],
		hangupCause: undefined,
		detached: false,
		moveTo: (state) => {
			leg.channelStates.push(state);
			return true;
		},
		moveCallStateTo: (state) => {
			leg.callStates.push(state);
			return true;
		},
		setBridge: (bridgeId) => {
			leg.bridgeId = bridgeId;
		},
		setBridgePeer: (peerLegId) => {
			leg.bridgePeers.push(peerLegId);
		},
		addFlag: (flag) => {
			leg.flags.add(flag);
		},
		removeFlag: (flag) => {
			leg.flags.delete(flag);
		},
		markHangup: (cause) => {
			leg.hangupCause ??= cause;
		},
		detach: () => {
			leg.detached = true;
		},
		...overrides,
	};
	return leg;
}

/** Pairs two legs as if a bridge had already joined them. */
function bridgePair(left: FakeLeg, right: FakeLeg, bridgeId = "bridge-1"): void {
	left.bridgeId = bridgeId;
	right.bridgeId = bridgeId;
	left.peerMediaChannelId = right.mediaChannelId;
	right.peerMediaChannelId = left.mediaChannelId;
}

interface PublishedEvent {
	readonly type: CallEvent;
	readonly legId: string;
	readonly data: Record<string, unknown>;
}

interface HarnessOptions {
	readonly legs?: readonly FakeLeg[];
	readonly media?: FakeMediaPortOptions;
	/** How the router answers. Defaults to bridging the leg to a freshly minted peer. */
	readonly route?: (leg: ControlledLeg, request: RouteRequest) => Promise<RouteOutcome>;
	readonly ringing?: readonly PickupCandidate[];
	readonly lot?: ParkLot | undefined;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const parks = new ParkRegistry();
	const published: PublishedEvent[] = [];
	const routes: RouteRequest[] = [];
	const legs = new Map<string, FakeLeg>(
		(options.legs ?? []).map((leg) => [leg.mediaChannelId, leg]),
	);

	const media = makeFakeMediaPort({
		...options.media,
		onSnoop: (request) => {
			signals.emit(legSignalKey(request.snoopChannelId), { kind: "entered" });
			options.media?.onSnoop?.(request);
		},
	});

	// A real media server reports `RecordingFinished` when the object is CLOSED, which is the whole
	// reason `stopRecording` waits for it. Emitting at `record` time instead would let a truncated
	// recording pass the spec.
	const stopRecording = media.stopRecording.bind(media);
	(media as { stopRecording: (name: string) => Promise<void> }).stopRecording = async (name) => {
		await stopRecording(name);
		signals.emit(recordingSignalKey(name), { kind: "recording-finished", durationMs: 12_000 });
	};

	const host: CallControlHost = {
		legFor: (mediaChannelId) => legs.get(mediaChannelId),
		ringingFor: async () => options.ringing ?? [],
		publish: async (leg, type, data) => {
			published.push({ type, legId: leg.legId, data });
		},
		route: async (leg, request) => {
			routes.push(request);
			if (options.route !== undefined) {
				return await options.route(leg, request);
			}
			// The default router behaves like a walk that found a destination: it stops the caller's
			// hold music at the moment of bridging, then bridges.
			await request.beforeBridge?.();
			const peer = fakeLeg(`peer-${request.destination}`);
			legs.set(peer.mediaChannelId, peer);
			const bridgeId = `route-bridge-${request.destination}`;
			bridgePair(leg as FakeLeg, peer, bridgeId);
			return { status: "bridged", peerMediaChannelId: peer.mediaChannelId, notes: [] };
		},
		parkLotFor: async () => ("lot" in options ? options.lot : LOT),
		parkLotForSlot: async () => ("lot" in options ? options.lot : LOT),
	};

	const timers: { fn: () => void; ms: number }[] = [];
	let counter = 0;
	const control = new CallControl({
		media,
		signals,
		parks,
		host,
		settings: { application: "optimiq-engine", recordingFormat: "wav" },
		newId: () => `id-${String(++counter)}`,
		now: () => 1_000,
		setTimer: (fn, ms) => {
			timers.push({ fn, ms });
			return { cancel: () => undefined };
		},
	});

	return {
		control,
		media,
		signals,
		parks,
		published,
		routes,
		timers,
		legs,
		eventsOf: (type: CallEvent) => published.filter((event) => event.type === type),
	};
}

describe("hold", () => {
	it("takes the leg out of its bridge BEFORE the music starts", async () => {
		const agent = fakeLeg("a");
		const caller = fakeLeg("c");
		bridgePair(agent, caller);
		const h = harness({ legs: [agent, caller] });

		const result = await h.control.hold(caller);

		expect(result.ok).toBe(true);
		expect(h.media.methods()).toEqual(["removeFromBridge", "hold", "startMusicOnHold"]);
		expect(caller.callStates).toEqual(["held"]);
		expect(caller.flags.has("hold")).toBe(true);
		expect(h.control.isHeld("c")).toBe(true);
		expect(h.eventsOf("channel.held")[0]?.legId).toBe("leg-c");
	});

	it("keeps the media path up for a soft hold — no re-INVITE mid-transfer", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller] });
		await h.control.hold(caller, { soft: true });
		expect(h.media.methods()).not.toContain("hold");
		expect(h.media.methods()).toContain("startMusicOnHold");
	});

	it("refuses a second hold and refuses a leg that never answered", async () => {
		const caller = fakeLeg("c");
		const unanswered = fakeLeg("u", { isAnswered: false });
		const h = harness({ legs: [caller, unanswered] });

		await h.control.hold(caller);
		expect(await h.control.hold(caller)).toEqual({
			ok: false,
			reason: "the leg is already on hold",
		});
		const refused = await h.control.hold(unanswered);
		expect(refused.ok).toBe(false);
	});

	it("does not fail the hold when the music class is missing — silence beats a dropped call", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller], media: { musicOnHoldFails: true } });
		expect((await h.control.hold(caller)).ok).toBe(true);
		expect(h.control.isHeld("c")).toBe(true);
	});

	it("puts the leg back in its bridge, through the transient unheld state", async () => {
		const agent = fakeLeg("a");
		const caller = fakeLeg("c");
		bridgePair(agent, caller, "bridge-7");
		const h = harness({ legs: [agent, caller] });

		await h.control.hold(caller);
		const result = await h.control.unhold(caller);

		expect(result.ok).toBe(true);
		expect(h.media.methods().slice(3)).toEqual(["stopMusicOnHold", "unhold", "addToBridge"]);
		expect(caller.callStates).toEqual(["held", "unheld", "active"]);
		expect(caller.bridgeId).toBe("bridge-7");
		expect(caller.flags.has("hold")).toBe(false);
		expect(h.eventsOf("channel.unheld")).toHaveLength(1);
	});

	it("refuses to unhold a leg that is not held", async () => {
		const h = harness();
		expect(await h.control.unhold(fakeLeg("c"))).toEqual({
			ok: false,
			reason: "the leg is not on hold",
		});
	});
});

describe("park", () => {
	it("claims an orbit, moves the call out of the bridge and breaks the peer link", async () => {
		const parker = fakeLeg("p");
		const caller = fakeLeg("c");
		bridgePair(parker, caller);
		const h = harness({ legs: [parker, caller] });

		const outcome = await h.control.park(caller);

		expect(outcome.result.ok).toBe(true);
		expect(outcome.slot).toBe(401);
		expect(h.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
		expect(h.media.methods()).toEqual(["removeFromBridge", "startMusicOnHold"]);
		// The parker hanging up must not take the parked caller with them.
		expect(caller.bridgePeers).toEqual([undefined]);
		expect(parker.bridgePeers).toEqual([undefined]);
		expect(caller.channelStates).toEqual(["parked"]);
		expect(caller.flags.has("park")).toBe(true);
	});

	it("publishes the slot somebody dials to collect it, and the timeout", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller] });
		await h.control.park(caller);
		expect(h.eventsOf("call.parked")[0]?.data).toMatchObject({
			legId: "leg-c",
			parkLotId: LOT.parkLotId,
			slot: "401",
			timeoutMs: 60_000,
		});
		expect(h.timers[0]?.ms).toBe(60_000);
	});

	it("honours an explicit orbit and refuses one that is taken", async () => {
		const first = fakeLeg("c1");
		const second = fakeLeg("c2");
		const h = harness({ legs: [first, second] });

		expect((await h.control.park(first, { orbit: "402" })).slot).toBe(402);
		const clash = await h.control.park(second, { orbit: "402" });
		expect(clash.result).toEqual({ ok: false, reason: "orbit 402 is already occupied" });
	});

	it("refuses an orbit outside the lot and a full lot", async () => {
		const h = harness({ legs: [fakeLeg("c1"), fakeLeg("c2"), fakeLeg("c3")] });
		const outside = await h.control.park(fakeLeg("x"), { orbit: "999" });
		expect(outside.result).toEqual({ ok: false, reason: "orbit 999 is not a slot in this lot" });

		await h.control.park(fakeLeg("c1"));
		await h.control.park(fakeLeg("c2"));
		const full = await h.control.park(fakeLeg("c3"));
		expect(full.result.ok).toBe(false);
		expect((full.result as { reason: string }).reason).toContain("every orbit in the lot is taken");
	});

	it("says so when the organization has no lot at all", async () => {
		const h = harness({ lot: undefined });
		const outcome = await h.control.park(fakeLeg("c"));
		expect(outcome.result).toEqual({
			ok: false,
			reason: "this organization has no park lot",
		});
	});

	it("releases the claim when the media move fails, so the orbit is not lost", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller], media: { musicOnHoldFails: true } });
		const outcome = await h.control.park(caller);
		expect(outcome.result.ok).toBe(false);
		expect(h.parks.parkedCount).toBe(0);
	});
});

describe("retrieval", () => {
	it("bridges the retriever to the parked caller and reports why the park ended", async () => {
		const caller = fakeLeg("c");
		const retriever = fakeLeg("r");
		const h = harness({ legs: [caller, retriever] });
		await h.control.park(caller);

		const result = await h.control.unpark(retriever, { orbit: "401" });

		expect(result.ok).toBe(true);
		expect(h.media.methods()).toEqual([
			"startMusicOnHold",
			"stopMusicOnHold",
			"createBridge",
			"addToBridge",
		]);
		expect(h.eventsOf("call.unparked")[0]?.data).toMatchObject({
			slot: "401",
			reason: "retrieved",
			retrievedByLegId: "leg-r",
		});
		expect(h.eventsOf("channel.bridged")).toHaveLength(1);
		expect(caller.callStates).toEqual(["held", "unheld", "active"]);
		expect(retriever.bridgePeers).toEqual(["leg-c"]);
		expect(caller.bridgePeers).toEqual([undefined, "leg-r"]);
	});

	it("is exclusive: the second retriever is told the truth, not bridged to the same caller", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller, fakeLeg("r1"), fakeLeg("r2")] });
		await h.control.park(caller);

		expect((await h.control.unpark(fakeLeg("r1"), { orbit: "401" })).ok).toBe(true);
		expect(await h.control.unpark(fakeLeg("r2"), { orbit: "401" })).toEqual({
			ok: false,
			reason: "nothing is parked on orbit 401",
		});
	});

	it("refuses a retrieval with no orbit and one outside every lot", async () => {
		const h = harness();
		expect((await h.control.unpark(fakeLeg("r"))).ok).toBe(false);
		const outside = await h.control.unpark(fakeLeg("r"), { orbit: "999" });
		expect(outside.ok).toBe(false);
	});

	it("puts the caller back in their own slot when the bridge is refused", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller, fakeLeg("r")], media: { bridgeFails: true } });
		await h.control.park(caller);

		const result = await h.control.unpark(fakeLeg("r"), { orbit: "401" });

		expect(result.ok).toBe(false);
		expect(h.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
	});
});

describe("the park timeout", () => {
	it("returns the call to the parker through the ordinary routing path", async () => {
		const parker = fakeLeg("p");
		const caller = fakeLeg("c");
		bridgePair(parker, caller);
		const h = harness({ legs: [parker, caller] });
		await h.control.park(caller);

		h.timers[0]?.fn();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(h.routes[0]).toMatchObject({ destination: "n-p", context: "internal" });
		expect(h.eventsOf("call.unparked")[0]?.data).toMatchObject({ reason: "timeout" });
		expect(h.parks.parkedCount).toBe(0);
	});

	it("leaves a call parked when there is nobody to return it to", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller] });
		await h.control.park(caller);

		h.timers[0]?.fn();
		// The park registry's claim/restore round trip is asynchronous now that a claim may be shared,
		// so the timeout's own continuation takes several microtasks to settle.
		await flush();

		expect(h.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
		expect(h.routes).toHaveLength(0);
	});
});

describe("blind transfer", () => {
	it("re-routes the transferee and hangs the transferor up with BLIND_TRANSFER", async () => {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		const h = harness({ legs: [transferor, transferee] });

		const result = await h.control.transfer(transferor, { kind: "blind", destination: "1002" });

		expect(result.ok).toBe(true);
		expect(transferor.hangupCause).toBe("BLIND_TRANSFER");
		expect(h.media.hungUp()).toEqual([{ channelId: "t", cause: "BLIND_TRANSFER" }]);
		expect(h.routes[0]).toMatchObject({ destination: "1002", context: "internal" });
		expect(h.eventsOf("call.transferred")[0]?.data).toMatchObject({
			legId: "leg-e",
			kind: "blind",
			destination: "1002",
			transferorLegId: "leg-t",
		});
	});

	it("holds the transferee with music and stops it at the moment of bridging", async () => {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		const h = harness({ legs: [transferor, transferee] });

		await h.control.transfer(transferor, { kind: "blind", destination: "1002" });

		const methods = h.media.methods();
		expect(methods).toContain("startMusicOnHold");
		// Stopped by the router's `beforeBridge`, not before the walk started: the transferee hears
		// music for the whole time the target is ringing.
		expect(methods.indexOf("stopMusicOnHold")).toBeGreaterThan(methods.indexOf("startMusicOnHold"));
		expect(h.control.isHeld("e")).toBe(false);
		expect(transferee.callStates).toEqual(["held", "unheld", "active"]);
	});

	it("breaks the peer link so the transferor's teardown cannot follow the call it handed over", async () => {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		const h = harness({ legs: [transferor, transferee] });

		await h.control.transfer(transferor, { kind: "blind", destination: "1002" });

		expect(transferor.bridgePeers).toContain(undefined);
		expect(transferee.bridgePeers[0]).toBeUndefined();
	});

	it("tries the fallback destination when the first route does not connect", async () => {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		const attempts: string[] = [];
		const h = harness({
			legs: [transferor, transferee],
			route: async (_leg, request) => {
				attempts.push(request.destination);
				return attempts.length === 1
					? { status: "hangup", cause: "USER_BUSY", notes: [] }
					: { status: "bridged", notes: [] };
			},
		});

		const result = await h.control.transfer(transferor, {
			kind: "blind",
			destination: "1002",
			fallbackDestination: "1003",
		});

		expect(attempts).toEqual(["1002", "1003"]);
		expect(result.ok).toBe(true);
		expect(h.eventsOf("call.transferred")[0]?.data).toMatchObject({ destination: "1003" });
	});

	it("refuses a transfer on a leg that is bridged to nobody, and one with no destination", async () => {
		const lonely = fakeLeg("t");
		const h = harness({ legs: [lonely] });
		expect((await h.control.transfer(lonely, { kind: "blind", destination: "1002" })).ok).toBe(
			false,
		);
		expect((await h.control.transfer(lonely, { kind: "blind", destination: "  " })).ok).toBe(false);
	});
});

describe("attended transfer", () => {
	function consulting() {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		return { transferor, transferee, h: harness({ legs: [transferor, transferee] }) };
	}

	it("holds the transferee and routes the transferor to the target", async () => {
		const { transferor, transferee, h } = consulting();

		const result = await h.control.transfer(transferor, { kind: "attended", destination: "1002" });

		expect(result).toEqual({ ok: true, detail: "consulting 1002" });
		expect(h.control.isHeld("e")).toBe(true);
		expect(h.control.hasPendingTransfer("t")).toBe(true);
		expect(transferee.channelStates).toContain("hibernating");
		expect(h.routes[0]).toMatchObject({ destination: "1002" });
		// Soft hold: the transferee is held and unheld within seconds, so no re-INVITE.
		expect(h.media.methods()).not.toContain("hold");
	});

	it("joins the transferee to the consultation's own bridge and drops the transferor", async () => {
		const { transferor, transferee, h } = consulting();
		await h.control.transfer(transferor, { kind: "attended", destination: "1002" });
		const target = h.legs.get("peer-1002") as FakeLeg;

		const result = await h.control.completeTransfer(transferor);

		expect(result.ok).toBe(true);
		// The target's media never stops: the transferee joins the bridge the consultation is in.
		expect(transferee.bridgeId).toBe("route-bridge-1002");
		expect(transferee.callStates).toEqual(["held", "unheld", "active"]);
		expect(transferor.hangupCause).toBe("ATTENDED_TRANSFER");
		expect(transferor.bridgePeers.at(-1)).toBeUndefined();
		expect(target.bridgePeers).toContain("leg-e");
		expect(h.eventsOf("call.transferred")[0]?.data).toMatchObject({
			legId: "leg-e",
			kind: "attended",
			destination: "1002",
			transferorLegId: "leg-t",
			targetLegId: "leg-peer-1002",
		});
		expect(h.control.hasPendingTransfer("t")).toBe(false);
	});

	it("completes on the transferor's hangup, which is the classic semantics", async () => {
		const { transferor, transferee, h } = consulting();
		await h.control.transfer(transferor, { kind: "attended", destination: "1002" });

		await h.control.onLegEnded("t");

		expect(transferee.bridgeId).toBe("route-bridge-1002");
		expect(h.eventsOf("call.transferred")).toHaveLength(1);
	});

	it("cancels back to the original call, hanging the consultation up first", async () => {
		const { transferor, transferee, h } = consulting();
		await h.control.transfer(transferor, { kind: "attended", destination: "1002" });

		const result = await h.control.cancelTransfer(transferor);

		expect(result.ok).toBe(true);
		expect(h.media.hungUp()).toEqual([{ channelId: "peer-1002", cause: "ORIGINATOR_CANCEL" }]);
		expect(h.control.isHeld("e")).toBe(false);
		expect(transferee.callStates).toEqual(["held", "unheld", "active"]);
		expect(h.eventsOf("call.transferred")).toHaveLength(0);
	});

	it("returns the transferee when the consultation never connects", async () => {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		const h = harness({
			legs: [transferor, transferee],
			route: async () => ({ status: "hangup", cause: "USER_BUSY", notes: [] }),
		});

		const result = await h.control.transfer(transferor, { kind: "attended", destination: "1002" });

		expect(result.ok).toBe(false);
		expect(h.control.hasPendingTransfer("t")).toBe(false);
		expect(h.control.isHeld("e")).toBe(false);
	});

	it("abandons the transfer when the held transferee hangs up mid-consultation", async () => {
		const { transferor, h } = consulting();
		await h.control.transfer(transferor, { kind: "attended", destination: "1002" });

		h.signals.emit(legSignalKey("e"), { kind: "ended", cause: "NORMAL_CLEARING", causeCode: 16 });
		await Promise.resolve();
		await Promise.resolve();

		expect(h.control.hasPendingTransfer("t")).toBe(false);
	});

	it("refuses to complete or cancel a transfer that was never started", async () => {
		const h = harness();
		const leg = fakeLeg("t");
		expect((await h.control.completeTransfer(leg)).ok).toBe(false);
		expect((await h.control.cancelTransfer(leg)).ok).toBe(false);
	});
});

describe("pickup", () => {
	function ringing() {
		const caller = fakeLeg("caller");
		const ringingLeg = fakeLeg("ringing", { destinationNumber: "200", isAnswered: false });
		bridgePair(caller, ringingLeg, "no-bridge");
		caller.bridgeId = undefined;
		ringingLeg.bridgeId = undefined;
		return { caller, ringingLeg };
	}

	it("takes the caller, not the ringing phone, and detaches the walk that was ringing it", async () => {
		const { caller, ringingLeg } = ringing();
		const picker = fakeLeg("picker", { isAnswered: false });
		const h = harness({
			legs: [caller, ringingLeg, picker],
			ringing: [{ ringingLeg, callerLeg: caller, ringingSinceMs: 0 }],
		});

		const result = await h.control.pickup(picker, { kind: "directed", extension: "200" });

		expect(result.ok).toBe(true);
		// Without this the walk would take the no-answer branch and send a caller who is already
		// talking to somebody to voicemail.
		expect(caller.detached).toBe(true);
		expect(ringingLeg.hangupCause).toBe("PICKED_OFF");
		expect(h.media.hungUp()).toEqual([{ channelId: "ringing", cause: "PICKED_OFF" }]);
		expect(picker.bridgePeers).toEqual(["leg-caller"]);
		expect(caller.bridgePeers.at(-1)).toBe("leg-picker");
	});

	it("answers the picker and publishes both the pickup and the bridge", async () => {
		const { caller, ringingLeg } = ringing();
		const picker = fakeLeg("picker", { isAnswered: false });
		const h = harness({
			legs: [caller, ringingLeg, picker],
			ringing: [{ ringingLeg, callerLeg: caller, ringingSinceMs: 0 }],
		});

		await h.control.pickup(picker, { kind: "directed", extension: "200" });

		expect(h.media.methods()).toEqual(["hangup", "answer", "createBridge", "addToBridge"]);
		expect(h.eventsOf("call.picked-up")[0]?.data).toMatchObject({
			legId: "leg-picker",
			pickedUpLegId: "leg-caller",
			kind: "directed",
			extension: "200",
			abandonedLegId: "leg-ringing",
		});
		expect(h.eventsOf("channel.bridged")).toHaveLength(1);
	});

	it("says nothing is ringing rather than guessing", async () => {
		const h = harness({ ringing: [] });
		expect(await h.control.pickup(fakeLeg("p"), { kind: "directed", extension: "200" })).toEqual({
			ok: false,
			reason: "nothing is ringing at extension 200",
		});
		expect(await h.control.pickup(fakeLeg("p"), { kind: "group", extension: "" })).toEqual({
			ok: false,
			reason: "nothing is ringing in this pickup group",
		});
	});

	it("skips a candidate that is already tearing down", async () => {
		const { caller, ringingLeg } = ringing();
		caller.isTearingDown = true;
		const h = harness({
			legs: [caller, ringingLeg],
			ringing: [{ ringingLeg, callerLeg: caller, ringingSinceMs: 0 }],
		});
		expect((await h.control.pickup(fakeLeg("p"), { kind: "directed", extension: "200" })).ok).toBe(
			false,
		);
	});
});

/**
 * Pickup GROUPS.
 *
 * The three-case rule, asserted directly rather than through the orchestrator's registry walk: the
 * walk is iteration, this is the feature. Each case is a decision somebody will want to revisit, and
 * getting the third one backwards is how a restriction becomes decorative.
 */
describe("the pickup group filter", () => {
	const SALES = { pickupGroup: "sales" };
	const FLOOR = { pickupGroup: "floor-2" };
	const UNGROUPED = {};

	it("does not exist at all for a tenant with no groups", () => {
		expect(pickupGroupFilter({ "1001": UNGROUPED, "1002": UNGROUPED }, "1001")).toBeUndefined();
	});

	it("lets a caller answer a phone in their own group", () => {
		const covers = pickupGroupFilter({ "1001": SALES, "1002": SALES }, "1001");
		expect(covers?.("1002")).toBe(true);
	});

	it("refuses a phone in a different group — the receptionist and the warehouse", () => {
		const covers = pickupGroupFilter({ "1001": SALES, "1002": FLOOR }, "1001");
		expect(covers?.("1002")).toBe(false);
	});

	it("leaves an ungrouped extension available to everybody, which is the documented fallback", () => {
		const covers = pickupGroupFilter({ "1001": SALES, "1002": UNGROUPED }, "1001");
		expect(covers?.("1002")).toBe(true);
	});

	it("refuses a groupless caller a grouped phone, or the restriction is decorative", () => {
		const covers = pickupGroupFilter({ "1001": UNGROUPED, "1002": SALES }, "1001");
		expect(covers?.("1002")).toBe(false);
	});

	it("refuses a caller the artifact has never heard of a grouped phone", () => {
		const covers = pickupGroupFilter({ "1002": SALES }, "+15559998888");
		expect(covers?.("1002")).toBe(false);
	});

	it("treats a ringing leg with no destination number as ungrouped, and therefore available", () => {
		const covers = pickupGroupFilter({ "1001": SALES }, "1001");
		expect(covers?.(undefined)).toBe(true);
	});

	it("does not match a caller whose identity is missing to the blank-number entry", () => {
		const covers = pickupGroupFilter({ "1001": SALES, "1002": FLOOR }, undefined);
		expect(covers?.("1002")).toBe(false);
	});

	it("trims the caller's number, so a stray space does not lose them their group", () => {
		const covers = pickupGroupFilter({ "1001": SALES, "1002": SALES }, " 1001 ");
		expect(covers?.("1002")).toBe(true);
	});
});

describe("on-demand recording", () => {
	it("taps both directions and files the object exactly the way voicemail does", async () => {
		const leg = fakeLeg("c");
		const h = harness({ legs: [leg] });

		const outcome = await h.control.startRecording(leg);

		expect(outcome.result.ok).toBe(true);
		expect(outcome.objectKey).toBe(`${ORG}/call-c/id-1.wav`);
		const snoop = h.media.calls.find((call) => call.method === "snoop")?.args[0] as {
			spy: string;
			snoopChannelId: string;
		};
		expect(snoop.spy).toBe("both");
		// Recorded on the TAP, not on the leg: that is what puts both parties in the object.
		expect(h.media.calls.find((call) => call.method === "record")?.args[0]).toBe(
			snoop.snoopChannelId,
		);
		expect(h.eventsOf("channel.record.started")[0]?.data).toMatchObject({
			legId: "leg-c",
			recordingId: "id-1",
			objectKey: `${ORG}/call-c/id-1.wav`,
			kind: "call",
		});
	});

	it("refuses a second recording on the same leg", async () => {
		const leg = fakeLeg("c");
		const h = harness({ legs: [leg] });
		await h.control.startRecording(leg);
		expect(await h.control.startRecording(leg)).toMatchObject({
			result: { ok: false, reason: "this leg is already being recorded" },
		});
	});

	it("reports a media server that refuses the tap", async () => {
		const leg = fakeLeg("c");
		const h = harness({ legs: [leg], media: { snoopFails: true } });
		const outcome = await h.control.startRecording(leg);
		expect(outcome.result.ok).toBe(false);
		expect(h.control.recordingFor("c")).toBeUndefined();
	});

	it("finalises the object before publishing the stop, then drops the tap", async () => {
		const leg = fakeLeg("c");
		const h = harness({ legs: [leg] });
		await h.control.startRecording(leg);

		const result = await h.control.stopRecording(leg);

		expect(result.ok).toBe(true);
		expect(h.media.methods()).toContain("stopRecording");
		expect(h.media.hungUp().map((entry) => entry.channelId)).toContain("id-2");
		expect(h.eventsOf("channel.record.stopped")[0]?.data).toMatchObject({
			recordingId: "id-1",
			objectKey: `${ORG}/call-c/id-1.wav`,
			durationMs: 12_000,
			reason: "completed",
		});
	});

	it("stops a running recording when the leg goes away", async () => {
		const leg = fakeLeg("c");
		const h = harness({ legs: [leg] });
		await h.control.startRecording(leg);

		await h.control.onLegEnded("c");

		expect(h.eventsOf("channel.record.stopped")).toHaveLength(1);
		expect(h.control.recordingFor("c")).toBeUndefined();
	});

	it("refuses to stop a recording that is not running", async () => {
		const h = harness();
		expect(await h.control.stopRecording(fakeLeg("c"))).toEqual({
			ok: false,
			reason: "this leg is not being recorded",
		});
	});
});

describe("teardown", () => {
	it("frees a parked call's orbit and says the caller abandoned it", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller] });
		await h.control.park(caller);

		await h.control.onLegEnded("c");

		expect(h.parks.parkedCount).toBe(0);
		expect(h.eventsOf("call.unparked")[0]?.data).toMatchObject({
			reason: "abandoned",
			slot: "401",
		});
	});

	it("forgets a held leg", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller] });
		await h.control.hold(caller);
		await h.control.onLegEnded("c");
		expect(h.control.isHeld("c")).toBe(false);
	});

	it("counts what it is holding, so a drain can wait for it", async () => {
		const caller = fakeLeg("c");
		const h = harness({ legs: [caller] });
		await h.control.hold(caller);
		expect(h.control.activeOperationCount).toBe(1);
		h.control.clear();
		expect(h.control.activeOperationCount).toBe(0);
	});
});
