import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { FakeClaimBucket } from "../nats/claim-store.fake";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "../routing/call-signals";
import { CLAIM_LEASE_MS, ParkRegistry } from "../routing/park-registry";
import { CallControl, pickupGroupFilter, tapSidesFor } from "./call-control";
import { ParkHandoffError } from "./park-handoff";
import type { FakeMediaPortOptions } from "../media/media-port.fake";
import type { ClaimBucket } from "../nats/claim-store";
import type {
	CallControlHost,
	ControlledLeg,
	ParkLot,
	PickupCandidate,
	RouteOutcome,
	RouteRequest,
	SupervisionTarget,
} from "./call-control";
import type { ParkHandoffClient } from "./park-handoff";
import type { CallEvent, ParkClaim, TapMode } from "@optimiq-voice/events";
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
	/** Answered calls `*0` can find, oldest first — what the orchestrator's registry scan produces. */
	readonly monitorable?: readonly SupervisionTarget[];
	readonly lot?: ParkLot | undefined;
	/** Shared park claims, for the specs that need two instances on one bucket. */
	readonly claims?: ClaimBucket<ParkClaim>;
	/** This instance's identity. Only meaningful together with {@link HarnessOptions.claims}. */
	readonly instanceId?: string;
	/** The engine-to-engine seam. Absent means "no cross-instance retrieval", as in production. */
	readonly parkHandoff?: ParkHandoffClient;
	/** The clock, shared by call control and the claim leases. */
	readonly now?: () => number;
	/** The tap is created and never enters the application — the race `openTap` guards against. */
	readonly tapNeverArrives?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const now = options.now ?? (() => 1_000);
	const parks = new ParkRegistry();
	if (options.claims !== undefined) {
		parks.bindClaims(options.claims, options.instanceId ?? "engine-a", now);
	}
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
		// A tap reaches Stasis before the HTTP response returns, which is exactly why the runtime
		// subscribes first. Emitting synchronously from inside the call reproduces that race; a fake
		// that emitted later would let a runtime that subscribed too late pass its specs.
		onTap: (request) => {
			if (options.tapNeverArrives !== true) {
				signals.emit(legSignalKey(request.tapChannelId), { kind: "entered" });
			}
			options.media?.onTap?.(request);
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
		legByLegId: (legId) => [...legs.values()].find((leg) => leg.legId === legId),
		ringingFor: async () => options.ringing ?? [],
		activeCallsFor: () => options.monitorable ?? [],
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
	const supervisionKeys = new Map<string, (mode: TapMode) => Promise<void>>();
	let counter = 0;
	const control = new CallControl({
		media,
		signals,
		parks,
		host,
		...(options.parkHandoff === undefined ? {} : { parkHandoff: options.parkHandoff }),
		// The real seam, not a stub: the mode keys are armed by this class and the spec has to be able
		// to press them, which is what the escalation tests do through `supervisionKeys.press`.
		supervisionKeys: {
			arm: (mediaChannelId, escalate) => {
				supervisionKeys.set(mediaChannelId, escalate);
			},
			disarm: (mediaChannelId) => {
				supervisionKeys.delete(mediaChannelId);
			},
		},
		// A short snoop budget, because two specs deliberately let a tap never arrive and the production
		// default would make each of them wait five real seconds for a timer that has already been
		// proved correct by the ones that do arrive.
		settings: { application: "optimiq-engine", recordingFormat: "wav", snoopTimeoutMs: 100 },
		newId: () => `id-${String(++counter)}`,
		now,
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
		supervisionKeys,
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

	it("does not bridge when the shared claim cannot be released", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const caller = fakeLeg("c");
		const retriever = fakeLeg("r");
		const h = harness({ legs: [caller, retriever], claims: bucket });
		await h.control.park(caller);
		bucket.failing = true;

		const result = await h.control.unpark(retriever, { orbit: "401" });

		expect(result).toMatchObject({ ok: false });
		expect((result as { readonly reason: string }).reason).toContain("cannot be claimed right now");
		expect(h.media.methods()).toEqual(["startMusicOnHold"]);
		expect(h.parks.at(LOT.parkLotId, 401, ORG)?.mediaChannelId).toBe("c");
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

// ---------------------------------------------------------------------------------------------
// Cross-instance retrieval
// ---------------------------------------------------------------------------------------------

/** The `park-claims` key orbit 401 is held under. Read directly, to assert the orbit is freed. */
const ORBIT_KEY = kvKeyFor.parkClaim(ORG, LOT.parkLotId, 401);

/**
 * Two engines behind one media server, sharing one `park-claims` bucket.
 *
 * The arrangement the whole feature exists for: a caller is parked by the engine handling THEIR
 * call, and collected from the engine handling the phone that dialled the orbit — a different
 * process, with a different leg registry, holding none of the other's channels.
 *
 * `owner.control.acceptParkHandoff` is wired in as the retriever's transport, which is exactly what
 * `ParkHandoffService` does over NATS. The request crosses a real seam and both sides are real; the
 * only thing missing is the broker, which `test/engine-integration.spec.ts` supplies.
 */
function twoInstances(
	options: {
		readonly ownerMedia?: FakeMediaPortOptions;
		readonly beforeHandoff?: () => Promise<void>;
		readonly transport?: ParkHandoffClient;
	} = {},
) {
	const bucket = new FakeClaimBucket<ParkClaim>();
	const caller = fakeLeg("c");
	const owner = harness({
		legs: [caller],
		claims: bucket,
		instanceId: "engine-owner",
		...(options.ownerMedia === undefined ? {} : { media: options.ownerMedia }),
	});

	const handoffs: string[] = [];
	const transport: ParkHandoffClient = options.transport ?? {
		handoff: async (ownerInstanceId, request) => {
			handoffs.push(ownerInstanceId);
			await options.beforeHandoff?.();
			return await owner.control.acceptParkHandoff(request);
		},
	};

	const retriever = fakeLeg("r");
	const collector = harness({
		legs: [retriever],
		claims: bucket.peer(),
		instanceId: "engine-collector",
		parkHandoff: transport,
	});

	return { bucket, owner, collector, caller, retriever, handoffs };
}

describe("cross-instance retrieval", () => {
	it("leaves the same-instance path alone: a local orbit never reaches the wire", async () => {
		const caller = fakeLeg("c");
		const retriever = fakeLeg("r");
		const h = harness({
			legs: [caller, retriever],
			claims: new FakeClaimBucket<ParkClaim>(),
			instanceId: "engine-a",
			parkHandoff: {
				handoff: async () => {
					throw new Error("the local path must not issue a handoff");
				},
			},
		});
		await h.control.park(caller);

		const result = await h.control.unpark(retriever, { orbit: "401" });

		expect(result.ok).toBe(true);
		expect(h.media.methods()).toEqual([
			"startMusicOnHold",
			"stopMusicOnHold",
			"createBridge",
			"addToBridge",
		]);
		expect(retriever.bridgePeers).toEqual(["leg-c"]);
	});

	it("asks the owning instance, which moves the media and frees the orbit", async () => {
		const { bucket, owner, collector, caller, retriever, handoffs } = twoInstances();
		await owner.control.park(caller);

		const result = await collector.control.unpark(retriever, { orbit: "401" });

		expect(result).toEqual({ ok: true, detail: "retrieved orbit 401 from engine-owner" });
		expect(handoffs).toEqual(["engine-owner"]);
		// The OWNER does the media, all of it. The retriever's own media server is untouched.
		expect(owner.media.methods()).toEqual([
			"startMusicOnHold",
			"stopMusicOnHold",
			"createBridge",
			"addToBridge",
		]);
		expect(collector.media.methods()).toEqual([]);
		// Both legs end up in one bridge, each one's state moved by the process that owns it.
		expect(retriever.bridgeId).toBe(caller.bridgeId);
		expect(retriever.bridgePeers).toEqual(["leg-c"]);
		expect(caller.bridgePeers).toEqual([undefined, "leg-r"]);
		expect(caller.callStates).toEqual(["held", "unheld", "active"]);
		expect(caller.flags.has("park")).toBe(false);
		expect(owner.parks.at(LOT.parkLotId, 401)).toBeUndefined();
		expect(bucket.entries.has(ORBIT_KEY)).toBe(false);
	});

	it("files the unpark on the owner's leg and the bridge on the retriever's", async () => {
		const { owner, collector, caller, retriever } = twoInstances();
		await owner.control.park(caller);
		await collector.control.unpark(retriever, { orbit: "401" });

		expect(owner.eventsOf("call.unparked")[0]).toMatchObject({
			legId: "leg-c",
			data: { slot: "401", reason: "retrieved", retrievedByLegId: "leg-r" },
		});
		expect(collector.eventsOf("call.unparked")).toHaveLength(0);
		expect(collector.eventsOf("channel.bridged")[0]).toMatchObject({
			legId: "leg-r",
			data: { peerLegId: "leg-c", mode: "media" },
		});
	});

	it("loses the race honestly when the call is collected while the handoff is in flight", async () => {
		let owner: ReturnType<typeof harness> | undefined;
		const pair = twoInstances({
			beforeHandoff: async () => {
				// A colleague on the OWNING instance dials the orbit first. The claim the retriever
				// read is a snapshot, and this is what makes it stale mid-flight.
				await owner?.control.unpark(fakeLeg("local"), { orbit: "401" });
			},
		});
		owner = pair.owner;
		await pair.owner.control.park(pair.caller);

		const result = await pair.collector.control.unpark(pair.retriever, { orbit: "401" });

		expect(result).toEqual({ ok: false, reason: "nothing is parked on orbit 401" });
		expect(pair.retriever.bridgeId).toBeUndefined();
	});

	it("refuses when the orbit holds a different call than the request named", async () => {
		const { owner, caller } = twoInstances();
		await owner.control.park(caller);

		const response = await owner.control.acceptParkHandoff({
			orgId: ORG,
			parkLotId: LOT.parkLotId,
			slot: 401,
			// The claim was reaped and re-taken between the retriever's read and its request.
			mediaChannelId: "somebody-else",
			retrieverInstanceId: "engine-collector",
			retrieverMediaChannelId: "r",
			retrieverLegId: "leg-r",
			bridgeId: "bridge-x",
		});

		expect(response).toMatchObject({ ok: false, reason: "claim_superseded" });
		expect(owner.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
	});

	it("answers a request from another tenant as though the orbit were empty", async () => {
		const { owner, caller } = twoInstances();
		await owner.control.park(caller);

		const response = await owner.control.acceptParkHandoff({
			orgId: "0195c0f0-1c2f-7000-8000-0000000000ff",
			parkLotId: LOT.parkLotId,
			slot: 401,
			mediaChannelId: "c",
			retrieverInstanceId: "engine-collector",
			retrieverMediaChannelId: "r",
			retrieverLegId: "leg-r",
			bridgeId: "bridge-x",
		});

		expect(response).toMatchObject({ ok: false, reason: "not_parked" });
		expect(owner.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
	});

	it("refuses when the retriever's channel is on a media server the owner cannot see", async () => {
		const { owner, collector, caller, retriever } = twoInstances({
			ownerMedia: { knowsChannel: (channelId) => channelId === "c" },
		});
		await owner.control.park(caller);

		const result = await collector.control.unpark(retriever, { orbit: "401" });

		expect(result).toEqual({
			ok: false,
			reason:
				"the call on orbit 401 is parked on an engine that does not share this media server, so it cannot be retrieved from here",
		});
		// Nothing moved, so the caller is still collectable from the instance that holds them.
		expect(owner.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
		expect(owner.media.methods()).toEqual(["startMusicOnHold"]);
	});

	it("puts the caller back in their orbit when the owner's bridge is refused", async () => {
		const { owner, collector, caller, retriever } = twoInstances({
			ownerMedia: { bridgeFails: true },
		});
		await owner.control.park(caller);

		const result = await collector.control.unpark(retriever, { orbit: "401" });

		expect(result.ok).toBe(false);
		expect(owner.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
		expect(owner.media.methods()).toContain("startMusicOnHold");
		expect(retriever.bridgeId).toBeUndefined();
	});

	it("reports an owner that did not answer, and leaves the call where it is", async () => {
		const { bucket, owner, collector, caller, retriever } = twoInstances({
			transport: {
				handoff: async (ownerInstanceId) => {
					throw new ParkHandoffError(ownerInstanceId, "no reply within 3000ms");
				},
			},
		});
		await owner.control.park(caller);

		const result = await collector.control.unpark(retriever, { orbit: "401" });

		expect(result).toEqual({
			ok: false,
			reason:
				"the engine holding orbit 401 (engine-owner) did not answer; the call could not be retrieved",
		});
		// Still parked, still claimed, still collectable — a timeout is not a retrieval.
		expect(owner.parks.at(LOT.parkLotId, 401)?.mediaChannelId).toBe("c");
		expect(bucket.entries.has(ORBIT_KEY)).toBe(true);
	});

	it("says so plainly when no handoff transport is wired at all", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const caller = fakeLeg("c");
		const owner = harness({ legs: [caller], claims: bucket, instanceId: "engine-owner" });
		await owner.control.park(caller);

		const retriever = fakeLeg("r");
		const collector = harness({
			legs: [retriever],
			claims: bucket.peer(),
			instanceId: "engine-collector",
		});

		expect(await collector.control.unpark(retriever, { orbit: "401" })).toEqual({
			ok: false,
			reason:
				"the call on orbit 401 is parked on another engine instance (engine-owner) and cannot be retrieved from here",
		});
	});
});

describe("retrieval from an engine that has died", () => {
	const PARKED_AT = 1_000;
	const COLLECTED_AT = PARKED_AT + CLAIM_LEASE_MS + 1;

	/** The owner parks, then stops heartbeating: the collector's clock is a full lease later. */
	function afterTheLease(retrieverMedia?: FakeMediaPortOptions) {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const caller = fakeLeg("c");
		const owner = harness({
			legs: [caller],
			claims: bucket,
			instanceId: "engine-dead",
			now: () => PARKED_AT,
		});
		const retriever = fakeLeg("r");
		const collector = harness({
			legs: [retriever],
			claims: bucket.peer(),
			instanceId: "engine-live",
			now: () => COLLECTED_AT,
			parkHandoff: {
				handoff: async () => {
					throw new Error("a dead instance is never asked anything");
				},
			},
			...(retrieverMedia === undefined ? {} : { media: retrieverMedia }),
		});
		return { bucket, owner, collector, caller, retriever };
	}

	it("takes the claim over and collects the caller the dead engine left behind", async () => {
		const { bucket, owner, collector, caller, retriever } = afterTheLease();
		await owner.control.park(caller);

		const result = await collector.control.unpark(retriever, { orbit: "401" });

		expect(result).toEqual({ ok: true, detail: "retrieved orbit 401 from engine-dead" });
		expect(collector.media.methods()).toEqual(["stopMusicOnHold", "createBridge", "addToBridge"]);
		expect(retriever.bridgePeers).toEqual(["leg-c"]);
		expect(collector.eventsOf("channel.bridged")[0]).toMatchObject({
			legId: "leg-r",
			data: { peerLegId: "leg-c" },
		});
		// The orbit is freed rather than inherited: this instance holds no leg for that channel and
		// has nothing to heartbeat for.
		expect(bucket.entries.has(ORBIT_KEY)).toBe(false);
		expect(collector.parks.at(LOT.parkLotId, 401)).toBeUndefined();
	});

	it("refuses, and frees the orbit, when the channel went with the engine", async () => {
		const { bucket, owner, collector, caller, retriever } = afterTheLease({
			knowsChannel: () => false,
		});
		await owner.control.park(caller);

		const result = await collector.control.unpark(retriever, { orbit: "401" });

		expect(result).toEqual({
			ok: false,
			reason:
				"the call on orbit 401 was parked by an engine that has gone (engine-dead) and is no longer reachable",
		});
		expect(collector.media.methods()).toEqual([]);
		expect(bucket.entries.has(ORBIT_KEY)).toBe(false);
	});

	it("lets exactly one of two retrievers collect the orphan", async () => {
		const { bucket, owner, collector, caller, retriever } = afterTheLease();
		await owner.control.park(caller);

		const second = fakeLeg("r2");
		const rival = harness({
			legs: [second],
			claims: bucket.peer(),
			instanceId: "engine-live-2",
			now: () => COLLECTED_AT,
		});

		expect((await collector.control.unpark(retriever, { orbit: "401" })).ok).toBe(true);
		expect(await rival.control.unpark(second, { orbit: "401" })).toEqual({
			ok: false,
			reason: "nothing is parked on orbit 401",
		});
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

	it("sends the transferee to the fallback when the target is gone at completion time", async () => {
		const transferor = fakeLeg("t");
		const transferee = fakeLeg("e");
		bridgePair(transferor, transferee);
		const destinations: string[] = [];
		const h = harness({
			legs: [transferor, transferee],
			route: async (_leg, request) => {
				destinations.push(request.destination);
				return { status: "bridged", notes: [] };
			},
		});
		await h.control.transfer(transferor, {
			kind: "attended",
			destination: "1002",
			fallbackDestination: "1003",
		});
		// The target hangs up while the transferor is still consulting, so the completion below has
		// no bridge to join the transferee to.
		transferor.peerMediaChannelId = undefined;
		transferor.bridgeId = undefined;

		const result = await h.control.onLegEnded("t");

		expect(destinations).toEqual(["1002", "1003"]);
		expect(h.eventsOf("call.transferred")[0]?.data).toMatchObject({
			legId: "leg-e",
			kind: "attended",
			destination: "1003",
		});
		expect(result).toBeUndefined();
	});

	it("falls back to the transferor when there is no fallback destination", async () => {
		const { transferor, transferee, h } = consulting();
		await h.control.transfer(transferor, { kind: "attended", destination: "1002" });
		transferor.peerMediaChannelId = undefined;
		transferor.bridgeId = undefined;

		const result = await h.control.completeTransfer(transferor);

		expect(result.ok).toBe(false);
		expect(h.control.isHeld("e")).toBe(false);
		expect(transferee.callStates).toEqual(["held", "unheld", "active"]);
		expect(h.eventsOf("call.transferred")).toHaveLength(0);
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

	it("refuses on a media plane whose bridges never decode, without attempting a tap", async () => {
		const leg = fakeLeg("c");
		// `mediad` v1: RTP is relayed and never decoded, so there are no samples to record.
		const h = harness({ legs: [leg], media: { bridgeMode: "proxy-media" } });

		const outcome = await h.control.startRecording(leg);

		expect(outcome.result.ok).toBe(false);
		expect(outcome.result.ok ? "" : outcome.result.reason).toContain("proxy-media");
		// The refusal is a deployment fact, decided here — not an error dragged back out of the
		// media server after a tap it was always going to reject.
		expect(h.media.methods()).not.toContain("snoop");
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

	it("forgets an ended parked channel locally when its fenced release cannot be confirmed", async () => {
		const caller = fakeLeg("c");
		const bucket = new FakeClaimBucket<ParkClaim>();
		const h = harness({ legs: [caller], claims: bucket });
		await h.control.park(caller);
		const key = kvKeyFor.parkClaim(ORG, LOT.parkLotId, 401);
		const revision = bucket.entries.get(key)?.revision;
		bucket.failing = true;

		await h.control.onLegEnded("c");

		expect(h.parks.forChannel("c")).toBeUndefined();
		expect(h.parks.parkedCount).toBe(0);
		bucket.failing = false;
		expect(await h.parks.heartbeat()).toBe(0);
		expect(bucket.entries.get(key)?.revision).toBe(revision);
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

// =================================================================================================
// Supervision — `*0`, and the mode keys
// =================================================================================================

/**
 * The mode table, pinned directly.
 *
 * Everything around a tap — minting ids, waiting for it to enter the application, publishing —
 * would look the same whichever mode was asked for, so a suite that only exercised taps end to end
 * would pass with the two `speakTo` values swapped. This is the one place where a value in the wrong
 * column puts a supervisor's coaching into a CUSTOMER's ear, so it is asserted as a table.
 */
describe("tapSidesFor", () => {
	it("is silent for eavesdrop, whatever side the monitored party is on", () => {
		expect(tapSidesFor("eavesdrop", "a")).toEqual({ hear: "both", speakTo: "none" });
		expect(tapSidesFor("eavesdrop", "b")).toEqual({ hear: "both", speakTo: "none" });
	});

	it("speaks ONLY to the monitored party for whisper, following which side they are", () => {
		// The whole reason `monitoredSide` is a parameter: "coach the agent" is a statement about a
		// PARTY, and the agent is the b-leg on a call they received and the a-leg on one they placed.
		expect(tapSidesFor("whisper", "b")).toEqual({ hear: "both", speakTo: "b" });
		expect(tapSidesFor("whisper", "a")).toEqual({ hear: "both", speakTo: "a" });
	});

	it("speaks to everybody for barge", () => {
		expect(tapSidesFor("barge", "a")).toEqual({ hear: "both", speakTo: "both" });
		expect(tapSidesFor("barge", "b")).toEqual({ hear: "both", speakTo: "both" });
	});

	it("always hears both parties — there is no product for half a conversation", () => {
		for (const mode of ["eavesdrop", "whisper", "barge"] as const) {
			for (const side of ["a", "b"] as const) {
				expect(tapSidesFor(mode, side).hear).toBe("both");
			}
		}
	});
});

describe("monitor", () => {
	/** A supervisor's idle leg and the agent's live one, as the orchestrator's scan would offer them. */
	function supervision(overrides: { readonly targetSide?: "a" | "b" } = {}) {
		const supervisor = fakeLeg("sup", { isAnswered: false, callerIdNumber: "1900" });
		const agent = fakeLeg("agent", { callerIdNumber: "2002" });
		const customer = fakeLeg("cust");
		bridgePair(agent, customer, "live-bridge");
		return {
			supervisor,
			agent,
			customer,
			options: {
				legs: [supervisor, agent, customer],
				monitorable: [
					{ leg: agent, side: overrides.targetSide ?? ("b" as const), startedAtMs: 100 },
				],
			},
		};
	}

	it("taps the monitored leg and bridges the supervisor to it", async () => {
		const s = supervision();
		const h = harness(s.options);

		const result = await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		expect(result.ok).toBe(true);
		const tap = h.media.taps()[0];
		expect(tap?.targetChannelId).toBe("agent");
		expect(tap?.supervisorChannelId).toBe("sup");
		expect(tap?.targetSide).toBe("b");
		expect(tap?.hear).toBe("both");
		expect(tap?.speakTo).toBe("none");
		// The supervisor's leg is answered and put in the tap's bridge. `*0` is dialled from an idle
		// handset, so nobody answered it before there was something to connect it to.
		expect(h.media.methods()).toContain("answer");
		expect(s.supervisor.bridgeId).toBe(tap?.bridgeId);
		// And NOT given a bridge peer: the thing on the other side is a tap, which has no leg id.
		expect(s.supervisor.bridgePeers).toEqual([]);
	});

	it("subscribes to the tap BEFORE creating it", async () => {
		// The fake emits `entered` from inside `tap`, which is what a real snoop does — it reaches
		// Stasis before the HTTP response. A runtime that subscribed afterwards would hang here.
		const s = supervision();
		const h = harness(s.options);
		const result = await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		expect(result.ok).toBe(true);
	});

	it("publishes call.tap.started on the MONITORED call, naming the supervisor's leg", async () => {
		const s = supervision();
		const h = harness(s.options);
		await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		const started = h.eventsOf("call.tap.started")[0];
		// The envelope is the monitored call's — that is what makes "was this conversation monitored?"
		// answerable from a call id somebody has in front of them.
		expect(started?.legId).toBe("leg-agent");
		expect(started?.data).toEqual({
			legId: "leg-sup",
			mode: "eavesdrop",
			supervisorExtension: "1900",
			targetExtension: "2002",
			targetLegId: "leg-agent",
			supervisorCallId: "call-sup",
		});
		// No `previousMode` on the first start: that is what distinguishes "began monitoring" from
		// "changed how they were monitoring".
		expect(started?.data.previousMode).toBeUndefined();
	});

	it("refuses on a media plane that never decodes, without touching it", async () => {
		const s = supervision();
		const h = harness({ ...s.options, media: { bridgeMode: "proxy-media" } });

		const result = await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		expect(result).toEqual({
			ok: false,
			reason:
				"this media plane bridges in proxy-media mode, which never decodes the audio, so a call on it cannot be monitored",
		});
		expect(h.media.taps()).toEqual([]);
	});

	it("refuses when nobody at the extension is on a call this engine holds", async () => {
		const supervisor = fakeLeg("sup", { isAnswered: false });
		const h = harness({ legs: [supervisor], monitorable: [] });

		const result = await h.control.monitor(supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		expect(result).toEqual({
			ok: false,
			reason: "nobody at extension 2002 is on a call this engine is handling",
		});
	});

	it("refuses a second tap on the same supervising leg", async () => {
		const s = supervision();
		const h = harness(s.options);
		const request = {
			extension: "2002",
			mode: "eavesdrop" as const,
			supervisorExtension: "1900",
		};
		await h.control.monitor(s.supervisor, request);

		expect(await h.control.monitor(s.supervisor, request)).toEqual({
			ok: false,
			reason: "this leg is already monitoring a call",
		});
	});

	it("cleans up and refuses when the tap never reaches the application", async () => {
		const s = supervision();
		const h = harness({ ...s.options, tapNeverArrives: true });

		const result = await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		expect(result.ok).toBe(false);
		expect(h.media.methods()).toContain("stopTap");
		// The tap channel is hung up, and the monitored legs are untouched.
		expect(h.media.hungUp().map((entry) => entry.channelId)).not.toContain("agent");
		expect(h.control.tapFor("sup")).toBeUndefined();
	});

	it("refuses when the media plane rejects the tap outright, and never throws", async () => {
		const s = supervision();
		const h = harness({ ...s.options, media: { tapFails: true } });

		const result = await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false ? result.reason : "").toContain("refused a tap on extension 2002");
	});

	it("whispers to the a-leg when the monitored extension PLACED the call", async () => {
		const s = supervision({ targetSide: "a" });
		const h = harness(s.options);

		await h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "whisper",
			supervisorExtension: "1900",
		});

		expect(h.media.taps()[0]?.speakTo).toBe("a");
	});
});

describe("the supervisor's mode keys", () => {
	function supervising() {
		const supervisor = fakeLeg("sup", { isAnswered: false, callerIdNumber: "1900" });
		const agent = fakeLeg("agent");
		const customer = fakeLeg("cust");
		bridgePair(agent, customer, "live-bridge");
		const h = harness({
			legs: [supervisor, agent, customer],
			monitorable: [{ leg: agent, side: "b" as const, startedAtMs: 100 }],
		});
		return { h, supervisor, agent };
	}

	it("arms the escalation on the SUPERVISOR's leg and disarms it when the tap ends", async () => {
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		expect(s.h.supervisionKeys.has("sup")).toBe(true);
		// And on that leg only: nothing is armed on the people being listened to.
		expect(s.h.supervisionKeys.has("agent")).toBe(false);

		await s.h.control.onLegEnded("sup");
		expect(s.h.supervisionKeys.has("sup")).toBe(false);
	});

	it("re-taps on an escalation, because a snoop's whisper direction is fixed at creation", async () => {
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});

		await (s.h.supervisionKeys.get("sup") as (mode: TapMode) => Promise<void>)("whisper");

		const taps = s.h.media.taps();
		expect(taps).toHaveLength(2);
		expect(taps[0]?.speakTo).toBe("none");
		expect(taps[1]?.speakTo).toBe("b");
		// The old one is taken down first, so the supervisor is never in two bridges at once.
		const methods = s.h.media.methods();
		expect(methods.indexOf("stopTap")).toBeLessThan(methods.lastIndexOf("tap"));
		expect(s.h.control.tapFor("sup")?.mode).toBe("whisper");
	});

	it("publishes ended{escalated} and then started{previousMode}", async () => {
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		await (s.h.supervisionKeys.get("sup") as (mode: TapMode) => Promise<void>)("barge");

		// The pair, not a single `changed` event: each interval a call was monitored is bounded by its
		// own start and end with the mode that applied during it.
		const ended = s.h.eventsOf("call.tap.ended");
		expect(ended).toHaveLength(1);
		expect(ended[0]?.data).toMatchObject({
			mode: "eavesdrop",
			reason: "escalated",
			targetExtension: "2002",
		});

		const started = s.h.eventsOf("call.tap.started");
		expect(started).toHaveLength(2);
		expect(started[1]?.data).toMatchObject({ mode: "barge", previousMode: "eavesdrop" });
		// Both on the monitored call, exactly as the first one was.
		expect(started[1]?.legId).toBe("leg-agent");
	});

	it("does nothing at all when the supervisor presses the mode they are already on", async () => {
		// Tearing the audio down and building it back would put a gap in their ear for nothing.
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		await (s.h.supervisionKeys.get("sup") as (mode: TapMode) => Promise<void>)("eavesdrop");

		expect(s.h.media.taps()).toHaveLength(1);
		expect(s.h.eventsOf("call.tap.ended")).toEqual([]);
	});

	it("refuses an escalation on a leg with no tap", async () => {
		const s = supervising();
		expect(await s.h.control.escalate("sup", "barge")).toEqual({
			ok: false,
			reason: "this leg is not monitoring a call",
		});
	});
});

describe("a tap ending", () => {
	function supervising() {
		const supervisor = fakeLeg("sup", { isAnswered: false, callerIdNumber: "1900" });
		const agent = fakeLeg("agent");
		const customer = fakeLeg("cust");
		bridgePair(agent, customer, "live-bridge");
		const h = harness({
			legs: [supervisor, agent, customer],
			monitorable: [{ leg: agent, side: "b" as const, startedAtMs: 100 }],
		});
		return { h, supervisor, agent, customer };
	}

	it("leaves the monitored call ALIVE when the supervisor hangs up", async () => {
		// The invariant `MediaPort.stopTap` states, and the one worth a spec of its own: getting it
		// wrong drops live customer calls every time somebody stops listening.
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		s.h.media.calls.length = 0;

		await s.h.control.onLegEnded("sup");

		expect(s.h.media.methods()).toContain("stopTap");
		// Nothing was hung up: not the agent, not the customer, and not the supervisor (whose leg is
		// already going away — hanging it up again would be a second teardown).
		expect(s.h.media.hungUp()).toEqual([]);
		expect(s.agent.hangupCause).toBeUndefined();
		expect(s.customer.hangupCause).toBeUndefined();

		const ended = s.h.eventsOf("call.tap.ended")[0];
		expect(ended?.data).toMatchObject({ reason: "supervisor-ended", mode: "eavesdrop" });
		expect(ended?.data.durationMs).toBe(0);
		expect(s.h.control.tapFor("sup")).toBeUndefined();
	});

	it("drops the supervisor when the MONITORED call ends", async () => {
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		s.h.media.calls.length = 0;

		s.h.signals.emit(legSignalKey("agent"), {
			kind: "ended",
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});
		await flush();

		// A supervisor left holding a line with nothing on it would believe they were still listening.
		expect(s.h.media.hungUp().map((entry) => entry.channelId)).toEqual(["sup"]);
		expect(s.h.eventsOf("call.tap.ended")[0]?.data).toMatchObject({ reason: "target-ended" });
	});

	it("counts a live tap, so a drain can wait for it", async () => {
		const s = supervising();
		await s.h.control.monitor(s.supervisor, {
			extension: "2002",
			mode: "eavesdrop",
			supervisorExtension: "1900",
		});
		expect(s.h.control.activeOperationCount).toBe(1);
		s.h.control.clear();
		expect(s.h.control.activeOperationCount).toBe(0);
	});
});
