import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../ari/media-port.fake";
import { fakeAgent, fakeMembership, makeFakeQueueServices } from "../queue/queue-services.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { extensionNode, hangupNode, planOf, queueNode } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { OriginatedLeg, WalkerChannel } from "./plan-walker";
import type { PlanNode } from "@optimiq-voice/routing";
import type { ChannelState, HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * The seam: a `queue` node walked by the real {@link PlanWalker} over the real
 * {@link import("../queue/queue-session").QueueSession}, with only the media server and the ACD
 * ports faked.
 *
 * `queue-session.spec.ts` proves the distribution logic against a fake call port. This file proves
 * the OTHER half — that the walker's media primitives are wired to it correctly: that an agent leg
 * goes through the leg hooks (and therefore gets a CDR), that music actually starts on the caller's
 * channel, that a bridge happens, and that the queue's timeout branch is taken rather than a
 * generic `NO_ANSWER` hangup. Neither file can catch what the other does.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE_ID = "0195c0f0-1c2f-7000-8000-0000000000e1";

type LegReaction = "answer" | "reject" | "silent";

interface HarnessOptions {
	readonly agents?: readonly ReturnType<typeof fakeAgent>[];
	readonly reactions?: Record<string, LegReaction>;
	readonly seed?: Readonly<Record<string, "available" | "logged-out">>;
	readonly noServices?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const states: ChannelState[] = [];
	const originatedLegs: OriginatedLeg[] = [];
	const hungUpByWalker: { channelId: string; cause: HangupCause }[] = [];
	const state = { answered: false, tearingDown: false, bridgeId: undefined as string | undefined };

	const agents = options.agents ?? [fakeAgent("aa", { contact: "PJSIP/2001" })];
	const services = makeFakeQueueServices({
		orgId: ORG_ID,
		membership: fakeMembership(ORG_ID, QUEUE_ID, agents),
	});
	for (const agent of agents) {
		services.agents.seed(agent.agentId, options.seed?.[agent.agentId] ?? "available");
	}

	const reactionFor = (endpoint: string): LegReaction => {
		for (const [fragment, reaction] of Object.entries(options.reactions ?? {})) {
			if (endpoint.includes(fragment)) {
				return reaction;
			}
		}
		return "silent";
	};

	const media = makeFakeMediaPort({
		onOriginate: (request) => {
			const reaction = reactionFor(request.endpoint);
			if (reaction === "answer") {
				signals.emit(legSignalKey(request.channelId), { kind: "answered" });
			} else if (reaction === "reject") {
				signals.emit(legSignalKey(request.channelId), {
					kind: "ended",
					cause: "CALL_REJECTED",
					causeCode: 21,
				});
			}
		},
	});

	const channel: WalkerChannel = {
		mediaChannelId: A_CHANNEL,
		channelId: A_LEG_ID,
		callId: CALL_ID,
		organizationId: ORG_ID,
		callerIdNumber: "+15551234567",
		callerIdName: "Ada",
		get isTearingDown(): boolean {
			return state.tearingDown;
		},
		get isAnswered(): boolean {
			return state.answered;
		},
		moveTo: (next) => {
			states.push(next);
			return true;
		},
		setBridge: (bridgeId) => {
			state.bridgeId = bridgeId;
		},
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
		if (verb.verb === "play") {
			return { verb: "play", endReason: "completed", playbackRef: "pb-1", elapsedMs: 1 };
		}
		return { verb: verb.verb as never, endReason: "completed" };
	};

	let counter = 0;
	const walker = new PlanWalker({
		media,
		signals,
		channel,
		execute,
		publish: async () => undefined,
		settings: { answerTimeoutMs: 200, defaultRingTimeoutSeconds: 1 },
		peerLegId: (mediaChannelId) => `leg-of-${mediaChannelId}`,
		legs: {
			originated: (leg) => {
				originatedLegs.push(leg);
			},
			hangingUp: (mediaChannelId, cause) => {
				hungUpByWalker.push({ channelId: mediaChannelId, cause });
			},
			bridged: () => undefined,
		},
		...(options.noServices === true ? {} : { queue: services }),
		// A poll interval of zero with an instant `delay` keeps a "nobody answers" walk bounded by
		// the queue's own maxWait rather than by wall-clock patience.
		queueSettings: { pollIntervalMs: 0, agentRingTimeoutSeconds: 1, random: () => 0 },
		newId: () => {
			counter += 1;
			return `id-${String(counter)}`;
		},
		delay: async () => undefined,
	});

	return { walker, media, signals, services, verbs, states, state, originatedLegs, hungUpByWalker };
}

function verbNames(verbs: readonly Verb[]): string[] {
	return verbs.map((verb) => verb.verb);
}

describe("walking a queue node", () => {
	it("answers the caller, starts music, rings the agent and bridges", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		const outcome = await h.walker.walk({
			plan: planOf([queueNode("q", { queueId: QUEUE_ID })]),
		});

		expect(outcome.status).toBe("bridged");
		expect(verbNames(h.verbs)).toContain("answer");
		expect(h.media.methods()).toContain("startMusicOnHold");
		expect(h.media.originated().map((request) => request.endpoint)).toEqual(["PJSIP/2001"]);
		expect(h.media.methods()).toContain("createBridge");
	});

	it("stops the music before the agent's leg is dialled", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		await h.walker.walk({ plan: planOf([queueNode("q", { queueId: QUEUE_ID })]) });

		const methods = h.media.methods();
		expect(methods.indexOf("stopMusicOnHold")).toBeLessThan(methods.indexOf("originate"));
	});

	it("reports the queue as the call's destination, for the CDR", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		const outcome = await h.walker.walk({
			plan: planOf([queueNode("q", { queueId: QUEUE_ID })]),
		});
		expect(outcome.destination).toEqual({ destinationType: "queue", destinationRef: QUEUE_ID });
	});

	it("puts the agent leg through the leg hooks, so it gets a CDR of its own", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		await h.walker.walk({ plan: planOf([queueNode("q", { queueId: QUEUE_ID })]) });

		expect(h.originatedLegs).toHaveLength(1);
		expect(h.originatedLegs[0]).toMatchObject({
			endpoint: "PJSIP/2001",
			destinationType: "queue",
			destinationRef: QUEUE_ID,
		});
	});

	it("presents the CALLER's identity to the agent, not the queue's", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		await h.walker.walk({ plan: planOf([queueNode("q", { queueId: QUEUE_ID })]) });
		expect(h.media.originated()[0]?.callerId).toBe('"Ada" <+15551234567>');
	});

	it("takes the queue's timeout branch when the maximum wait expires", async () => {
		const nodes: PlanNode[] = [
			queueNode("q", { queueId: QUEUE_ID, maxWaitSeconds: 1, timeoutNodeId: "vm" }),
			extensionNode("vm", { number: "1999" }),
		];
		const h = harness({ reactions: { "PJSIP/2001": "silent", "PJSIP/1999": "answer" } });
		const outcome = await h.walker.walk({ plan: planOf(nodes) });

		expect(outcome.visited).toEqual(["q", "vm"]);
		expect(outcome.status).toBe("bridged");
	});

	it("hangs up with ALLOTTED_TIMEOUT when the queue has no timeout branch", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "silent" } });
		const outcome = await h.walker.walk({
			plan: planOf([queueNode("q", { queueId: QUEUE_ID, maxWaitSeconds: 1 })]),
		});

		expect(outcome.status).toBe("hangup");
		// Not `NO_ANSWER`: a queue that ran out of patience is a different fact from a phone nobody
		// picked up, and it is the one an SLA report is built on.
		expect(outcome.hangupCause).toBe("ALLOTTED_TIMEOUT");
	});

	it("ejects a caller fast when the queue has nobody logged in", async () => {
		const h = harness({ seed: { aa: "logged-out" } });
		const outcome = await h.walker.walk({
			plan: planOf([
				queueNode("q", {
					queueId: QUEUE_ID,
					maxWaitSeconds: 600,
					maxWaitNoAgentSeconds: 1,
					timeoutNodeId: "bye",
				}),
				hangupNode("bye", "NORMAL_CLEARING"),
			]),
		});
		expect(outcome.visited).toEqual(["q", "bye"]);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("hangs the agent leg up with ORIGINATOR_CANCEL when they do not answer", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "silent" } });
		await h.walker.walk({
			plan: planOf([queueNode("q", { queueId: QUEUE_ID, maxWaitSeconds: 1 })]),
		});
		expect(h.hungUpByWalker.some((leg) => leg.cause === "ORIGINATOR_CANCEL")).toBe(true);
	});

	it("moves the agent through ringing and on-call in the bucket", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		await h.walker.walk({ plan: planOf([queueNode("q", { queueId: QUEUE_ID })]) });
		expect(h.services.agents.transitions.map((transition) => transition.to)).toEqual([
			"ringing",
			"on-call",
		]);
	});

	it("publishes joined then answered on the queue subject family", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		await h.walker.walk({ plan: planOf([queueNode("q", { queueId: QUEUE_ID })]) });
		expect(h.services.events.types()).toEqual(["caller.joined", "caller.answered"]);
	});

	it("wraps the agent up when the bridged leg goes away", async () => {
		const h = harness({ reactions: { "PJSIP/2001": "answer" } });
		await h.walker.walk({ plan: planOf([queueNode("q", { queueId: QUEUE_ID })]) });

		const agentChannel = h.media.originated()[0]?.channelId as string;
		h.signals.emit(legSignalKey(agentChannel), {
			kind: "ended",
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});

		expect(h.services.agents.transitions.map((transition) => transition.to)).toContain("wrap-up");
	});
});
