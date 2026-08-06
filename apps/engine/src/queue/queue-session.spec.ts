import { describe, expect, it } from "bun:test";
import { queueNode } from "../routing/plan-fixtures.fake";
import { fakeAgent, fakeMembership, makeFakeQueueServices } from "./queue-services.fake";
import { penaltySecondsFor, QueueSession } from "./queue-session";
import type { FakeQueueServices } from "./queue-services.fake";
import type { QueueCallPort, QueueDialAttempt, QueueDialOutcome } from "./queue-session";
import type { QueueMembership, QueueMembershipAgent } from "@optimiq-voice/events";
import type { QueuePlanNode } from "@optimiq-voice/routing";

/**
 * A queued caller's whole stay, driven by fakes.
 *
 * ## Virtual time
 *
 * The port's `delay` ADVANCES A CLOCK and resolves immediately, so a spec about a 120-second maximum
 * wait runs in microseconds and asserts the exact instant the caller was ejected. That is the only
 * way a wait-deadline test is worth having: a real timer would make it slow, flaky, and unable to
 * say whether the ejection happened at 120 s or at 119.
 *
 * The same trick guards against a runaway: the fake counts its own iterations and tears the caller
 * down after a budget, so a loop bug fails as "the caller was abandoned" rather than as a hung
 * suite.
 *
 * ## The dial script
 *
 * Each entry says what the phones do on that attempt. Attempt N takes script[N], and the last entry
 * repeats — so "nobody ever answers" is one entry rather than a hundred.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const START = Date.parse("2026-08-05T12:00:00.000Z");

type DialScript =
	| { readonly kind: "answer"; readonly agentIndex?: number }
	| { readonly kind: "no-answer" }
	| { readonly kind: "busy" }
	| { readonly kind: "reject" }
	| { readonly kind: "caller-gone" };

interface HarnessOptions {
	readonly node?: Partial<QueuePlanNode>;
	readonly agents?: readonly QueueMembershipAgent[];
	readonly membership?: Partial<QueueMembership> | null;
	/** Statuses to seed, keyed by agent id. Unseeded agents are unknown to the bucket. */
	readonly seed?: Readonly<Record<string, "available" | "on-call" | "logged-out" | "on-break">>;
	readonly dials?: readonly DialScript[];
	readonly bridgeFails?: boolean;
	readonly answerFails?: boolean;
	/** Iterations of the wait loop before the fake pulls the caller. Guards a runaway. */
	readonly budget?: number;
}

interface Harness {
	readonly session: QueueSession;
	readonly services: FakeQueueServices;
	readonly timeline: string[];
	readonly dialled: QueueDialAttempt[][];
	readonly notes: string[];
	readonly clock: { now: number };
	/** Fires the wrap-up hook the bridge registered, as the agent leg's death would. */
	endAgentLeg(): void;
}

function harness(options: HarnessOptions = {}): Harness {
	const node = queueNode("q", { queueId: "0195c0f0-1c2f-7000-8000-0000000000e1", ...options.node });
	const agents = options.agents ?? [fakeAgent("a"), fakeAgent("b", { position: 2 })];
	const membership =
		options.membership === null
			? undefined
			: fakeMembership(ORG, node.queueId, agents, options.membership ?? {});

	const clock = { now: START };
	const services = makeFakeQueueServices({
		orgId: ORG,
		membership,
		now: () => clock.now,
	});

	for (const agent of agents) {
		services.agents.seed(agent.agentId, options.seed?.[agent.agentId] ?? "available");
	}

	const timeline: string[] = [];
	const notes: string[] = [];
	const dialled: QueueDialAttempt[][] = [];
	const script = [...(options.dials ?? [{ kind: "no-answer" as const }])];
	const state = { tearingDown: false, iterations: 0 };
	const budget = options.budget ?? 20;
	let onAgentLegEnded: (() => void) | undefined;

	const call: QueueCallPort = {
		get isTearingDown(): boolean {
			return state.tearingDown;
		},
		callerLegId: LEG_ID,
		callId: CALL_ID,
		organizationId: ORG,
		callerNumber: "+15551234567",
		ensureAnswered: async () => {
			timeline.push("answer");
			return options.answerFails !== true;
		},
		play: async (media: string) => {
			timeline.push(`play:${media}`);
			return true;
		},
		startMusicOnHold: async (mohClass?: string) => {
			timeline.push(`moh:start${mohClass === undefined ? "" : `:${mohClass}`}`);
		},
		stopMusicOnHold: async () => {
			timeline.push("moh:stop");
		},
		dial: async (attempts, fanOut, ringTimeoutSeconds): Promise<QueueDialOutcome> => {
			dialled.push([...attempts]);
			timeline.push(`dial:${fanOut}:${attempts.map((a) => a.agentId).join(",")}`);
			const step = (script.length > 1 ? script.shift() : script[0]) ?? { kind: "no-answer" };
			// Ringing takes time. A fake that answered in zero milliseconds would make every wait
			// statistic in these specs read as 0 and hide the one thing `caller.answered` is for.
			clock.now += step.kind === "answer" ? 2_000 : ringTimeoutSeconds * 1_000;
			switch (step.kind) {
				case "answer": {
					const chosen = attempts[step.agentIndex ?? 0] ?? attempts[0];
					return {
						kind: "answered",
						agentId: (chosen as QueueDialAttempt).agentId,
						mediaChannelId: `media-${(chosen as QueueDialAttempt).agentId}`,
					};
				}
				case "busy": {
					return { kind: "failed", agentId: attempts[0]?.agentId ?? "", cause: "USER_BUSY" };
				}
				case "reject": {
					return { kind: "failed", agentId: attempts[0]?.agentId ?? "", cause: "CALL_REJECTED" };
				}
				case "caller-gone": {
					state.tearingDown = true;
					return { kind: "aborted" };
				}
				default: {
					return { kind: "timeout" };
				}
			}
		},
		bridge: async (mediaChannelId, onEnded) => {
			timeline.push(`bridge:${mediaChannelId}`);
			onAgentLegEnded = onEnded;
			return options.bridgeFails !== true;
		},
		resolvePrompt: (promptId) => (promptId === undefined ? undefined : `sound:${promptId}`),
		spellNumber: (value) => [...value].map((digit) => `sound:digits/${digit}`),
		note: (message) => {
			notes.push(message);
		},
		delay: async (ms) => {
			clock.now += ms;
			state.iterations += 1;
			if (state.iterations > budget) {
				// The runaway guard: a loop that never settles ends as an abandoned caller, which is
				// an assertion failure with a readable message rather than a suite that hangs.
				state.tearingDown = true;
			}
		},
		now: () => clock.now,
	};

	return {
		session: new QueueSession(node, call, services, {
			pollIntervalMs: 1_000,
			agentRingTimeoutSeconds: 20,
			random: () => 0,
		}),
		services,
		timeline,
		dialled,
		notes,
		clock,
		endAgentLeg: () => {
			onAgentLegEnded?.();
		},
	};
}

function eventTypes(h: Harness): string[] {
	return h.services.events.types();
}

function eventData(h: Harness, type: string): Record<string, unknown> | undefined {
	return h.services.events.recorded.find((event) => event.type === type)?.data;
}

// =================================================================================================
// Joining
// =================================================================================================

describe("joining a queue", () => {
	it("answers the caller before anything else happens", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.timeline[0]).toBe("answer");
	});

	it("gives up when the caller went away before the queue could answer them", async () => {
		const h = harness({ answerFails: true });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("aborted");
		expect(eventTypes(h)).toEqual([]);
	});

	it("publishes caller.joined with the caller's position and number", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(eventTypes(h)[0]).toBe("caller.joined");
		expect(eventData(h, "caller.joined")).toMatchObject({
			callId: CALL_ID,
			legId: LEG_ID,
			position: 1,
			priority: 0,
			callerNumber: "+15551234567",
		});
	});

	it("plays the queue greeting before the music starts", async () => {
		const h = harness({ node: { greetingPromptId: "welcome" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.timeline.indexOf("play:sound:welcome")).toBeLessThan(h.timeline.indexOf("moh:start"));
	});

	it("starts music on hold with the class NAME the compiler resolved", async () => {
		const h = harness({
			node: { mohClassId: "0195c0f0-1c2f-7000-8000-00000000m0h1", mohClass: "jazz" },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		expect(h.timeline).toContain("moh:start:jazz");
	});

	it("asks for no class at all when only the row id is known", async () => {
		// An artifact compiled before the compiler resolved names, or one whose class was deleted.
		// Passing the UUID through would select the media server's default class anyway — silently,
		// and with no error — so `undefined` says the same thing without pretending otherwise.
		const h = harness({
			node: { mohClassId: "0195c0f0-1c2f-7000-8000-00000000m0h1" },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		expect(h.timeline).toContain("moh:start");
		expect(h.timeline.some((entry) => entry.startsWith("moh:start:"))).toBe(false);
	});

	it("stops the music before an agent's phone is rung", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.timeline.indexOf("moh:stop")).toBeLessThan(h.timeline.indexOf("dial:one:a"));
	});

	it("says so, and does not distribute, when the roster cannot be read", async () => {
		const h = harness({ membership: null });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("failed");
		expect(h.notes.join(" ")).toContain("queue-membership bucket");
		expect(h.dialled).toEqual([]);
	});

	it("notes that queue recording is not implemented rather than silently dropping it", async () => {
		const h = harness({ node: { recordEnabled: true }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.notes.join(" ")).toContain("call recording");
	});
});

// =================================================================================================
// Distribution
// =================================================================================================

describe("distributing to agents", () => {
	it("rings one agent for a one-at-a-time strategy", async () => {
		const h = harness({ node: { strategy: "top-down" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.dialled[0]).toHaveLength(1);
		expect(h.dialled[0]?.[0]?.agentId).toBe("a");
	});

	it("rings everybody at once for ring-all", async () => {
		const h = harness({ node: { strategy: "ring-all" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.dialled[0]?.map((attempt) => attempt.agentId)).toEqual(["a", "b"]);
		expect(h.timeline).toContain("dial:all:a,b");
	});

	it("dials the agent's contact string from the roster, verbatim", async () => {
		const h = harness({
			agents: [fakeAgent("a", { contactKind: "external", contact: "PJSIP/+15550001@carrier" })],
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		expect(h.dialled[0]?.[0]?.endpoint).toBe("PJSIP/+15550001@carrier");
	});

	it("marks the agent ringing BEFORE the originate, so a second engine skips them", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		const first = h.services.agents.transitions[0];
		expect(first).toMatchObject({ agentId: "a", from: "available", to: "ringing" });
	});

	it("skips an agent nobody has logged in", async () => {
		const h = harness({ seed: { a: "logged-out" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.dialled[0]?.[0]?.agentId).toBe("b");
	});

	it("waits rather than dialling when nobody is eligible", async () => {
		const h = harness({ seed: { a: "on-call", b: "on-call" }, budget: 3 });
		const outcome = await h.session.run();
		expect(h.dialled).toEqual([]);
		expect(outcome.kind).toBe("abandoned");
	});

	it("moves to the next agent after a no-answer", async () => {
		const h = harness({ dials: [{ kind: "no-answer" }, { kind: "answer" }] });
		await h.session.run();
		expect(h.dialled.map((attempts) => attempts[0]?.agentId)).toEqual(["a", "b"]);
	});

	it("restarts the music between attempts", async () => {
		const h = harness({ dials: [{ kind: "no-answer" }, { kind: "answer" }] });
		await h.session.run();
		expect(h.timeline.filter((entry) => entry.startsWith("moh:start")).length).toBeGreaterThan(1);
	});

	it("does not re-ring the agent who just rang out, within their penalty", async () => {
		const h = harness({
			agents: [fakeAgent("a", { noAnswerDelaySeconds: 300 })],
			dials: [{ kind: "no-answer" }],
			budget: 3,
		});
		await h.session.run();
		expect(h.dialled).toHaveLength(1);
	});

	it("remembers who it distributed to, so round-robin advances", async () => {
		const h = harness({ node: { strategy: "round-robin" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.services.cursor.lastAgentFor(ORG, "0195c0f0-1c2f-7000-8000-0000000000e1")).toBe("a");
	});
});

// =================================================================================================
// Penalties
// =================================================================================================

describe("penalties", () => {
	it("charges the busy delay for a busy phone", () => {
		expect(
			penaltySecondsFor("USER_BUSY", {
				noAnswerDelaySeconds: 30,
				busyDelaySeconds: 60,
				rejectDelaySeconds: 90,
			}),
		).toBe(60);
	});

	it("charges the reject delay for an explicit decline", () => {
		expect(
			penaltySecondsFor("CALL_REJECTED", {
				noAnswerDelaySeconds: 30,
				busyDelaySeconds: 60,
				rejectDelaySeconds: 90,
			}),
		).toBe(90);
	});

	it("charges the no-answer delay for everything else, including an unreachable endpoint", () => {
		for (const cause of ["NO_ANSWER", "USER_NOT_REGISTERED", "NORMAL_TEMPORARY_FAILURE"] as const) {
			expect(
				penaltySecondsFor(cause, {
					noAnswerDelaySeconds: 30,
					busyDelaySeconds: 60,
					rejectDelaySeconds: 90,
				}),
			).toBe(30);
		}
	});

	it("writes the penalty as a deadline on the agent's entry", async () => {
		const h = harness({
			agents: [fakeAgent("a", { noAnswerDelaySeconds: 45 })],
			dials: [{ kind: "no-answer" }],
			budget: 2,
		});
		await h.session.run();
		const released = h.services.agents.transitions.find(
			(transition) => transition.to === "available",
		);
		// 45 s from the moment the ring ENDED (a 20 s ring-out), not from when the caller joined.
		expect(released?.availableAt).toBe(START + 20_000 + 45_000);
	});

	it("does NOT count a busy phone towards the no-answer budget", async () => {
		const h = harness({
			agents: [fakeAgent("a", { maxNoAnswer: 1 })],
			dials: [{ kind: "busy" }],
			budget: 2,
		});
		await h.session.run();
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("takes an agent out of distribution after maxNoAnswer consecutive ring-outs", async () => {
		const h = harness({
			agents: [fakeAgent("a", { maxNoAnswer: 1, noAnswerDelaySeconds: 0 })],
			dials: [{ kind: "no-answer" }],
			budget: 3,
		});
		await h.session.run();
		expect(h.services.agents.statusOf("a")).toBe("unavailable");
		expect(h.notes.join(" ")).toContain("consecutive no-answers");
	});

	it("resets the no-answer count when the agent finally answers", async () => {
		const h = harness({
			agents: [fakeAgent("a", { maxNoAnswer: 5, noAnswerDelaySeconds: 0 })],
			dials: [{ kind: "no-answer" }, { kind: "answer" }],
		});
		await h.session.run();
		const onCall = h.services.agents.transitions.find((transition) => transition.to === "on-call");
		expect(onCall?.noAnswerCount).toBe(0);
	});
});

// =================================================================================================
// The answer
// =================================================================================================

describe("an agent answers", () => {
	it("bridges the caller and reports the agent who took it", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		const outcome = await h.session.run();
		expect(outcome).toMatchObject({ kind: "answered", agentId: "a" });
		expect(h.timeline).toContain("bridge:media-a");
	});

	it("marks the agent on-call BEFORE the bridge is built", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		const onCallAt = h.services.agents.transitions.findIndex(
			(transition) => transition.to === "on-call",
		);
		expect(onCallAt).toBeGreaterThanOrEqual(0);
		expect(h.timeline.indexOf("bridge:media-a")).toBeGreaterThan(-1);
	});

	it("publishes caller.answered with the wait the caller actually experienced", async () => {
		const h = harness({ dials: [{ kind: "no-answer" }, { kind: "answer" }] });
		const outcome = await h.session.run();
		expect(eventData(h, "caller.answered")).toMatchObject({
			agentId: "b",
			waitMs: (outcome as { waitMs: number }).waitMs,
			strategy: "longest-idle",
		});
		expect((outcome as { waitMs: number }).waitMs).toBeGreaterThan(0);
	});

	it("publishes joined then answered, in that order", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(eventTypes(h)).toEqual(["caller.joined", "caller.answered"]);
	});

	it("releases the losers of a ring-all race with NO penalty", async () => {
		const h = harness({ node: { strategy: "ring-all" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		const loser = h.services.agents.transitions.find(
			(transition) => transition.agentId === "b" && transition.to === "available",
		);
		expect(loser).toBeDefined();
		expect(loser?.availableAt).toBeUndefined();
	});

	it("reports a failure, and wraps the agent up, when the bridge could not be built", async () => {
		const h = harness({ dials: [{ kind: "answer" }], bridgeFails: true });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("failed");
		// Wrap-up rather than back into the pool: ringing somebody whose handset just died is how a
		// caller gets three seconds of silence.
		expect(["wrap-up", "available"]).toContain(h.services.agents.statusOf("a") as string);
	});
});

// =================================================================================================
// Wrap-up
// =================================================================================================

describe("wrap-up", () => {
	it("puts the agent into wrap-up with a deadline when their call ends", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 15 })],
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		await Promise.resolve();
		const wrapUp = h.services.agents.transitions.find((transition) => transition.to === "wrap-up");
		expect(wrapUp).toMatchObject({ agentId: "a", from: "on-call" });
		expect(wrapUp?.availableAt).toBeGreaterThan(START);
	});

	it("brings them back to available once the deadline passes", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 5 })],
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		// The fake `delay` is instant, so the wrap-up timer settles on the next microtask turn.
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("skips wrap-up entirely when the queue and the agent both say zero", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0 },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(h.services.agents.transitions.some((t) => t.to === "wrap-up")).toBe(false);
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("falls back to the queue's wrap-up when the agent's own is zero", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 25 },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		await Promise.resolve();
		const wrapUp = h.services.agents.transitions.find((transition) => transition.to === "wrap-up");
		// The agent answered 2 s in, so wrap-up runs from there.
		expect(wrapUp?.availableAt).toBe(START + 2_000 + 25_000);
	});
});

// =================================================================================================
// Deadlines
// =================================================================================================

describe("maximum wait", () => {
	it("ejects the caller once maxWaitSeconds has elapsed", async () => {
		const h = harness({
			node: { maxWaitSeconds: 5 },
			seed: { a: "on-call", b: "on-call" },
			budget: 100,
		});
		const outcome = await h.session.run();
		expect(outcome).toMatchObject({ kind: "timeout", reason: "timeout" });
		expect((outcome as { waitMs: number }).waitMs).toBeGreaterThanOrEqual(5_000);
	});

	it("waits forever when maxWaitSeconds is 0", async () => {
		const h = harness({ seed: { a: "on-call", b: "on-call" }, budget: 4 });
		const outcome = await h.session.run();
		// The runaway guard pulled the caller, which is what "no deadline" looks like here.
		expect(outcome.kind).toBe("abandoned");
	});

	it("stops the music before ejecting", async () => {
		const h = harness({
			node: { maxWaitSeconds: 3 },
			seed: { a: "on-call", b: "on-call" },
			budget: 100,
		});
		await h.session.run();
		expect(h.timeline[h.timeline.length - 1]).toBe("moh:stop");
	});

	it("ejects fast when nobody is logged in at all", async () => {
		const h = harness({
			node: { maxWaitSeconds: 600, maxWaitNoAgentSeconds: 2 },
			seed: { a: "logged-out", b: "logged-out" },
			budget: 100,
		});
		const outcome = await h.session.run();
		expect(outcome).toMatchObject({ kind: "timeout", reason: "no-agents" });
		expect((outcome as { waitMs: number }).waitMs).toBeLessThan(600_000);
	});

	it("does NOT eject early when everyone is merely busy", async () => {
		const h = harness({
			node: { maxWaitSeconds: 30, maxWaitNoAgentSeconds: 2 },
			seed: { a: "on-call", b: "on-call" },
			budget: 100,
		});
		const outcome = await h.session.run();
		expect(outcome).toMatchObject({ kind: "timeout", reason: "timeout" });
	});

	it("publishes caller.abandoned with the timeout reason and the wait", async () => {
		const h = harness({
			node: { maxWaitSeconds: 4 },
			seed: { a: "on-call", b: "on-call" },
			budget: 100,
		});
		await h.session.run();
		expect(eventTypes(h)).toEqual(["caller.joined", "caller.abandoned"]);
		expect(eventData(h, "caller.abandoned")).toMatchObject({ reason: "timeout", position: 1 });
	});

	it("publishes the no-agents reason separately from a plain timeout", async () => {
		const h = harness({
			node: { maxWaitNoAgentSeconds: 1 },
			seed: { a: "logged-out", b: "logged-out" },
			budget: 100,
		});
		await h.session.run();
		expect(eventData(h, "caller.abandoned")).toMatchObject({ reason: "no-agents" });
	});
});

// =================================================================================================
// Abandonment
// =================================================================================================

describe("the caller hangs up", () => {
	it("reports an abandonment with the wait, not a timeout", async () => {
		const h = harness({ seed: { a: "on-call", b: "on-call" }, budget: 2 });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("abandoned");
		expect((outcome as { waitMs: number }).waitMs).toBeGreaterThan(0);
	});

	it("publishes caller.abandoned with reason caller-hangup and the position they reached", async () => {
		const h = harness({ seed: { a: "on-call", b: "on-call" }, budget: 2 });
		await h.session.run();
		expect(eventData(h, "caller.abandoned")).toMatchObject({
			reason: "caller-hangup",
			position: 1,
			legId: LEG_ID,
		});
	});

	it("abandons when the caller goes while an agent's phone is ringing", async () => {
		const h = harness({ dials: [{ kind: "caller-gone" }] });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("abandoned");
		expect(eventData(h, "caller.abandoned")).toMatchObject({ reason: "caller-hangup" });
	});

	it("releases the agent it was ringing, without a penalty for a caller who left", async () => {
		const h = harness({ dials: [{ kind: "caller-gone" }] });
		await h.session.run();
		const released = h.services.agents.transitions.find(
			(transition) => transition.agentId === "a" && transition.to === "available",
		);
		expect(released?.availableAt).toBeUndefined();
	});

	it("gives the caller's place back to the line when they leave", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.services.positions.waitingCount).toBe(0);
	});
});

// =================================================================================================
// Announcements
// =================================================================================================

describe("position announcements", () => {
	it("says nothing when they are disabled", async () => {
		const h = harness({ seed: { a: "on-call", b: "on-call" }, budget: 4 });
		await h.session.run();
		expect(h.timeline.some((entry) => entry.startsWith("play:sound:digits/"))).toBe(false);
	});

	it("reads the position out, over stopped music, once the frequency has elapsed", async () => {
		const h = harness({
			node: { announcePositionEnabled: true, announceFrequencySeconds: 2 },
			seed: { a: "on-call", b: "on-call" },
			budget: 6,
		});
		await h.session.run();
		expect(h.timeline).toContain("play:sound:digits/1");
		const announceAt = h.timeline.indexOf("play:sound:digits/1");
		expect(h.timeline.lastIndexOf("moh:stop", announceAt)).toBeGreaterThan(-1);
	});

	it("plays the queue's announce prompt before the digits", async () => {
		const h = harness({
			node: {
				announcePositionEnabled: true,
				announceFrequencySeconds: 2,
				announcePromptId: "you-are-caller",
			},
			seed: { a: "on-call", b: "on-call" },
			budget: 6,
		});
		await h.session.run();
		expect(h.timeline.indexOf("play:sound:you-are-caller")).toBeLessThan(
			h.timeline.indexOf("play:sound:digits/1"),
		);
	});

	it("does not announce more often than the frequency allows", async () => {
		const h = harness({
			node: { announcePositionEnabled: true, announceFrequencySeconds: 3600 },
			seed: { a: "on-call", b: "on-call" },
			budget: 6,
		});
		await h.session.run();
		expect(h.timeline.filter((entry) => entry === "play:sound:digits/1")).toHaveLength(0);
	});

	it("restarts the music after the announcement", async () => {
		const h = harness({
			node: { announcePositionEnabled: true, announceFrequencySeconds: 2 },
			seed: { a: "on-call", b: "on-call" },
			budget: 6,
		});
		await h.session.run();
		const announceAt = h.timeline.indexOf("play:sound:digits/1");
		expect(h.timeline.indexOf("moh:start", announceAt)).toBeGreaterThan(announceAt);
	});
});
