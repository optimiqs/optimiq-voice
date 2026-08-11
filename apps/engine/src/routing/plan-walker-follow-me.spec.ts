import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import {
	extensionNode,
	hangupNode,
	planOf,
	trunkAttempt,
	trunkDialNode,
} from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { OriginatedLeg, PlanWalkerSettings, WalkerChannel, WalkInput } from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { FollowMeDestination, FollowMePlan, PlanNode } from "@optimiq-voice/routing";
import type { HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * Follow-me, as the plan walker executes it.
 *
 * The ladder is a field on the extension node, so these specs drive the walker exactly as the
 * extension specs do — the only difference is which branch of `extensionNode` is taken. What they
 * are about is the three things the ladder decides and nothing else does: which legs are
 * originated and in what order, what the losers of a race are hung up with, and where a ladder
 * that finds nobody lands.
 *
 * Which STRATEGY a ladder has is not tested here at all: it is a compiler decision written into
 * the artifact (`packages/routing`'s `follow-me.spec.ts` owns it), and re-deriving it here would
 * mean two copies of a rule with one source of truth.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";

type LegReaction =
	| { readonly kind: "answer" }
	| { readonly kind: "reject"; readonly cause: HangupCause }
	| { readonly kind: "unreachable" }
	/** Rings forever: the walker's own timeout is what has to end it. */
	| { readonly kind: "silent" };

interface HarnessOptions {
	/** How each originated endpoint behaves. Keyed by a substring of the endpoint. */
	readonly reactions?: Record<string, LegReaction>;
	readonly detached?: boolean;
	readonly settings?: Partial<PlanWalkerSettings>;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const published: { type: CallEvent; data: Record<string, unknown> }[] = [];
	const originatedLegs: OriginatedLeg[] = [];
	const hangingUp: { mediaChannelId: string; cause: HangupCause }[] = [];
	const bridged: { mediaChannelId: string; bridgeId: string }[] = [];
	const delays: number[] = [];
	const state = { answered: false, tearingDown: false, detached: options.detached ?? false };

	/**
	 * An endpoint nobody scripted DECLINES rather than ringing forever. A ladder's whole point is
	 * that the caller waits, so a silent default would make every spec here pay a real ring timeout
	 * to prove something about the hop after it.
	 */
	const reactionFor = (endpoint: string): LegReaction => {
		for (const [fragment, reaction] of Object.entries(options.reactions ?? {})) {
			if (endpoint.includes(fragment)) {
				return reaction;
			}
		}
		return { kind: "reject", cause: "NO_ANSWER" };
	};

	const media = makeFakeMediaPort({
		originateFails: (request) =>
			reactionFor(request.endpoint).kind === "unreachable"
				? new Error("endpoint has no contact")
				: undefined,
		onOriginate: (request) => {
			const reaction = reactionFor(request.endpoint);
			if (reaction.kind === "silent" || reaction.kind === "unreachable") {
				return;
			}
			if (reaction.kind === "answer") {
				signals.emit(legSignalKey(request.channelId), { kind: "answered" });
				return;
			}
			signals.emit(legSignalKey(request.channelId), {
				kind: "ended",
				cause: reaction.cause,
				causeCode: 16,
			});
		},
	});

	const channel: WalkerChannel = {
		mediaChannelId: A_CHANNEL,
		channelId: A_LEG_ID,
		callId: CALL_ID,
		organizationId: ORG_ID,
		callerIdNumber: "+15551234567",
		callerIdName: "Ada",
		get isDetached(): boolean {
			return state.detached;
		},
		get isTearingDown(): boolean {
			return state.tearingDown;
		},
		get isAnswered(): boolean {
			return state.answered;
		},
		moveTo: () => true,
		setBridge: () => undefined,
	};

	const execute = async (verb: Verb): Promise<VerbResult | undefined> => {
		verbs.push(verb);
		if (verb.verb === "answer") {
			state.answered = true;
			signals.emit(legSignalKey(A_CHANNEL), { kind: "answered" });
			return { verb: "answer", endReason: "completed" };
		}
		if (verb.verb === "hangup") {
			state.tearingDown = true;
			return { verb: "hangup", endReason: "completed" };
		}
		return { verb: verb.verb as never, endReason: "completed" };
	};

	let counter = 0;
	const walker = new PlanWalker({
		media,
		signals,
		channel,
		execute,
		publish: async (type, data) => {
			published.push({ type, data });
		},
		settings: { answerTimeoutMs: 200, ...options.settings },
		peerLegId: (mediaChannelId) => `leg-of-${mediaChannelId}`,
		legs: {
			originated: (leg) => originatedLegs.push(leg),
			hangingUp: (mediaChannelId, cause) => hangingUp.push({ mediaChannelId, cause }),
			bridged: (mediaChannelId, bridgeId) => bridged.push({ mediaChannelId, bridgeId }),
		},
		newId: () => {
			counter += 1;
			return `id-${String(counter)}`;
		},
		// Ring delays are asserted through the originate order, never waited on.
		delay: async (ms) => {
			delays.push(ms);
		},
	});

	return { walker, media, verbs, published, originatedLegs, hangingUp, bridged, delays, state };
}

function walkInput(nodes: readonly PlanNode[], overrides: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), ...overrides };
}

function hop(overrides: Partial<FollowMeDestination> = {}): FollowMeDestination {
	return {
		ordinal: 0,
		destination: "1002",
		delaySeconds: 0,
		// One second, so a spec that DOES let a leg ring out pays a second rather than a ring cycle.
		timeoutSeconds: 1,
		confirmRequired: false,
		targetNodeId: "desk",
		...overrides,
	};
}

function ladder(
	destinations: readonly FollowMeDestination[],
	overrides: Partial<FollowMePlan> = {},
): FollowMePlan {
	return { strategy: "sequential", ignoreBusy: false, destinations, ...overrides };
}

/** The mobile hop's trunk-dial node, and the hop that points at it. */
function mobileHop(overrides: Partial<FollowMeDestination> = {}): FollowMeDestination {
	return hop({
		ordinal: 1,
		destination: "+15559998888",
		targetNodeId: "route",
		dialedNumber: "+15559998888",
		...overrides,
	});
}

const DESK = extensionNode("desk", { number: "1002" });
const ROUTE = trunkDialNode("route");

function endpointsOf(h: ReturnType<typeof harness>): string[] {
	return h.media.originated().map((request) => request.endpoint);
}

// =================================================================================================
// Sequential
// =================================================================================================

describe("a sequential follow-me ladder", () => {
	it("rings the hops in ordinal order and bridges the one that answers", async () => {
		const h = harness({ reactions: { "PJSIP/+15559998888": { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop(), mobileHop()]),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(outcome.status).toBe("bridged");
		// The extension's own endpoint is NOT rung: a ladder replaces the plain dial.
		expect(endpointsOf(h)).toEqual(["PJSIP/1002", "PJSIP/+15559998888@carrier-a"]);
	});

	it("honours each hop's own delay and timeout", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					timeoutSeconds: 20,
					followMe: ladder([
						hop({ timeoutSeconds: 12 }),
						mobileHop({ delaySeconds: 7, timeoutSeconds: 35 }),
					]),
				}),
				DESK,
				ROUTE,
			]),
		);

		expect(h.delays).toEqual([7_000]);
		expect(h.media.originated().map((request) => request.timeoutSeconds)).toEqual([12, 35]);
	});

	it("falls back to the extension's own ring timeout when a hop specifies none", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					timeoutSeconds: 42,
					followMe: ladder([hop({ timeoutSeconds: 0 })]),
				}),
				DESK,
			]),
		);
		expect(h.media.originated()[0]?.timeoutSeconds).toBe(42);
	});

	it("stops at a busy hop unless the ladder ignores busy", async () => {
		const busy = { "PJSIP/1002": { kind: "reject" as const, cause: "USER_BUSY" as HangupCause } };

		const stops = harness({ reactions: busy });
		await stops.walker.walk(
			walkInput([
				extensionNode("ext", { number: "1001", followMe: ladder([hop(), mobileHop()]) }),
				DESK,
				ROUTE,
			]),
		);
		expect(endpointsOf(stops)).toEqual(["PJSIP/1002"]);

		const continues = harness({ reactions: busy });
		await continues.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop(), mobileHop()], { ignoreBusy: true }),
				}),
				DESK,
				ROUTE,
			]),
		);
		expect(endpointsOf(continues)).toHaveLength(2);
	});

	it("stops the moment the caller is taken over by a pickup", async () => {
		const h = harness({ detached: true });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", { number: "1001", followMe: ladder([hop(), mobileHop()]) }),
				DESK,
				ROUTE,
			]),
		);

		expect(outcome.status).toBe("aborted");
		expect(h.media.originated()).toHaveLength(0);
	});
});

// =================================================================================================
// Simultaneous
// =================================================================================================

describe("a simultaneous follow-me ladder", () => {
	it("originates every hop and bridges the first answer", async () => {
		const h = harness({ reactions: { "PJSIP/+15559998888": { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop(), mobileHop()], { strategy: "simultaneous" }),
				}),
				DESK,
				ROUTE,
			]),
		);

		expect(outcome.status).toBe("bridged");
		expect(endpointsOf(h)).toHaveLength(2);
	});

	it("hangs the losing hops up with LOSE_RACE, before the winner is bridged", async () => {
		const h = harness({
			reactions: {
				// Still ringing when the mobile picks up — a loser, not a leg that already ended.
				"PJSIP/1002": { kind: "silent" },
				"PJSIP/+15559998888": { kind: "answer" },
			},
		});
		await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop(), mobileHop()], { strategy: "simultaneous" }),
				}),
				DESK,
				ROUTE,
			]),
		);

		expect(h.hangingUp).toEqual([{ mediaChannelId: "id-1", cause: "LOSE_RACE" }]);
		const methods = h.media.methods();
		expect(methods.indexOf("hangup")).toBeLessThan(methods.indexOf("createBridge"));
	});

	it("gives up on legs that ring out, and lands on the no-answer branch", async () => {
		const h = harness({ reactions: { PJSIP: { kind: "silent" } } });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop(), mobileHop()], { strategy: "simultaneous" }),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(outcome.visited).toContain("vm");
		// Both silent legs were cancelled rather than left up — no winner, so not `LOSE_RACE`.
		expect(h.hangingUp.map((leg) => leg.cause)).toEqual(["ORIGINATOR_CANCEL", "ORIGINATOR_CANCEL"]);
	});
});

// =================================================================================================
// Where a ladder that finds nobody lands
// =================================================================================================

describe("a follow-me ladder that finds nobody", () => {
	it("takes the extension's own no-answer branch", async () => {
		const h = harness({ reactions: { PJSIP: { kind: "reject", cause: "NO_ANSWER" } } });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop(), mobileHop()]),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(outcome.visited).toEqual(["ext", "vm"]);
	});

	it("takes the busy branch when the last hop was busy", async () => {
		const h = harness({ reactions: { PJSIP: { kind: "reject", cause: "USER_BUSY" } } });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop()]),
					busyNodeId: "busy",
					noAnswerNodeId: "vm",
				}),
				DESK,
				hangupNode("vm", "NO_ANSWER"),
				hangupNode("busy", "USER_BUSY"),
			]),
		);
		expect(outcome.visited).toEqual(["ext", "busy"]);
	});

	it("takes the no-answer branch when the compiler refused every hop", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop({ targetNodeId: undefined })]),
					noAnswerNodeId: "vm",
				}),
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(h.media.originated()).toHaveLength(0);
		expect(outcome.visited).toEqual(["ext", "vm"]);
		expect(outcome.notes.join(" ")).toContain("refused by the compiler");
	});

	it("hangs up with NO_ANSWER when the extension has no no-answer branch at all", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", { number: "1001", followMe: ladder([hop({ targetNodeId: "gone" })]) }),
			]),
		);
		expect(outcome.status).toBe("hangup");
		expect(outcome.hangupCause).toBe("NO_ANSWER");
	});
});

// =================================================================================================
// Off-net hops
// =================================================================================================

describe("an off-net follow-me hop", () => {
	it("dials the trunk the compiler chose, with the number that route manipulated", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([mobileHop({ ordinal: 0, dialedNumber: "01115559998888" })]),
				}),
				trunkDialNode("route", { attempts: [trunkAttempt("carrier-b", 5)] }),
			]),
		);
		expect(endpointsOf(h)).toEqual(["PJSIP/01115559998888@carrier-b"]);
	});

	it("takes the lowest-order trunk of the route's chain", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([mobileHop({ ordinal: 0 })]),
				}),
				trunkDialNode("route", {
					attempts: [trunkAttempt("backup", 9), trunkAttempt("primary", 1)],
				}),
			]),
		);
		expect(endpointsOf(h)[0]).toContain("@primary");
	});

	it("presents the trunk's own ANI over the route's, and the route's over the caller's", async () => {
		const withTrunkOverride = harness();
		await withTrunkOverride.walker.walk(
			walkInput([
				extensionNode("ext", { number: "1001", followMe: ladder([mobileHop({ ordinal: 0 })]) }),
				trunkDialNode("route", {
					callerIdNumberOverride: "+15550000002",
					attempts: [{ ...trunkAttempt("carrier-a", 0), callerIdNumberOverride: "+15550000001" }],
				}),
			]),
		);
		expect(withTrunkOverride.media.originated()[0]?.callerId).toBe('"Ada" <+15550000001>');

		const withRouteOverride = harness();
		await withRouteOverride.walker.walk(
			walkInput([
				extensionNode("ext", { number: "1001", followMe: ladder([mobileHop({ ordinal: 0 })]) }),
				trunkDialNode("route", { callerIdNumberOverride: "+15550000002" }),
			]),
		);
		expect(withRouteOverride.media.originated()[0]?.callerId).toBe('"Ada" <+15550000002>');

		const withNeither = harness();
		await withNeither.walker.walk(
			walkInput([
				extensionNode("ext", { number: "1001", followMe: ladder([mobileHop({ ordinal: 0 })]) }),
				ROUTE,
			]),
		);
		expect(withNeither.media.originated()[0]?.callerId).toBe('"Ada" <+15551234567>');
	});

	it("skips a hop whose route lost every trunk, and says so", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([mobileHop({ ordinal: 0 })]),
					noAnswerNodeId: "vm",
				}),
				trunkDialNode("route", { attempts: [] }),
				hangupNode("vm", "NO_ANSWER"),
			]),
		);
		expect(h.media.originated()).toHaveLength(0);
		expect(outcome.notes.join(" ")).toContain("no usable trunk");
	});

	it("skips a hop that resolves to something that is not a leg", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop({ targetNodeId: "vm" })]),
					noAnswerNodeId: "vm",
				}),
				hangupNode("vm", "NO_ANSWER"),
			]),
		);
		expect(h.media.originated()).toHaveLength(0);
		expect(outcome.notes.join(" ")).toContain("cannot be dialled as a leg");
	});
});

// =================================================================================================
// B-leg bookkeeping
// =================================================================================================

describe("follow-me legs and their CDRs", () => {
	it("files every hop as an originated leg, with the number it reached", async () => {
		const h = harness({ reactions: { "PJSIP/+15559998888": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					extensionId: "ext-1001",
					followMe: ladder([hop(), mobileHop()], { strategy: "simultaneous" }),
				}),
				DESK,
				ROUTE,
			]),
		);

		expect(h.originatedLegs.map((leg) => leg.destinationNumber)).toEqual(["1002", "+15559998888"]);
		// Both legs are filed against the extension the ladder belongs to, which is where the call
		// was routed — the mobile is how it was reached, not what was dialled.
		expect(h.originatedLegs.every((leg) => leg.destinationRef === "ext-1001")).toBe(true);
		expect(h.originatedLegs.map((leg) => leg.label)).toEqual([
			"extension 1002",
			"follow-me +15559998888",
		]);
	});

	it("reports the bridge to the answering leg and publishes channel.bridged", async () => {
		const h = harness({ reactions: { "PJSIP/1002": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([extensionNode("ext", { number: "1001", followMe: ladder([hop()]) }), DESK]),
		);

		expect(h.bridged).toHaveLength(1);
		expect(h.published.map((event) => event.type)).toContain("channel.bridged");
	});

	it("dials a hop that asked for answer confirmation, and does not bridge it unasked", async () => {
		const h = harness({
			reactions: { "PJSIP/1002": { kind: "answer" } },
			settings: { confirmAttempts: 1, confirmTimeoutMs: 20 },
		});
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder([hop({ confirmRequired: true })]),
				}),
				DESK,
			]),
		);

		expect(h.media.originated()).toHaveLength(1);
		expect(h.bridged).toHaveLength(0);
		expect(outcome.notes.join(" ")).toContain("did not confirm the call");
	});
});

// =================================================================================================
// Precedence against the extension's other flags
// =================================================================================================

describe("follow-me against the extension's other flags", () => {
	it("does not run when forward-all is on", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					forwardAllNodeId: "fwd",
					followMe: ladder([hop()]),
				}),
				DESK,
				hangupNode("fwd", "NORMAL_CLEARING"),
			]),
		);

		expect(h.media.originated()).toHaveLength(0);
		expect(outcome.visited).toEqual(["ext", "fwd"]);
	});

	it("does not run when the extension is on do-not-disturb", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					doNotDisturb: true,
					busyNodeId: "busy",
					followMe: ladder([hop()]),
				}),
				DESK,
				hangupNode("busy", "USER_BUSY"),
			]),
		);

		expect(h.media.originated()).toHaveLength(0);
		expect(outcome.visited).toEqual(["ext", "busy"]);
	});

	it("leaves an extension with no ladder ringing its own endpoint", async () => {
		const h = harness();
		await h.walker.walk(walkInput([extensionNode("ext", { number: "1001" })]));
		expect(endpointsOf(h)).toEqual(["PJSIP/1001"]);
	});
});
