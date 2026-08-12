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
const OTHER_CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c2";
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
	/** The media server refuses the agent's whisper. The bridge must still happen. */
	readonly whisperFails?: boolean;
	/** The port throws outright, which is a different failure from a refusal and must also not block. */
	readonly whisperThrows?: boolean;
	readonly answerFails?: boolean;
	readonly stopMusicThrows?: boolean;
	readonly dialThrows?: boolean;
	readonly onCallTransitionFails?: boolean;
	/** Number of release writes and their confirming reads that report broker unavailability. */
	readonly releaseFailures?: number;
	readonly wrapUpFailures?: number;
	readonly afterCallAvailableFailures?: number;
	/** Iterations of the wait loop before the fake pulls the caller. Guards a runaway. */
	readonly budget?: number;
	/** Digits the caller presses, offered one per `pollDigit` — exactly as the signal watch feeds it. */
	readonly digits?: readonly string[];
	/** The media plane refuses the recording. The call must still connect. */
	readonly recordingFails?: boolean;
	readonly recordingThrows?: boolean;
}

interface Harness {
	readonly session: QueueSession;
	readonly node: QueuePlanNode;
	readonly services: FakeQueueServices;
	readonly timeline: string[];
	readonly dialled: QueueDialAttempt[][];
	readonly notes: string[];
	readonly clock: { now: number };
	readonly scheduledReleaseRetries: readonly { readonly delayMs: number }[];
	runNextReleaseRetry(): Promise<void>;
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
	if (options.onCallTransitionFails === true) {
		const transition = services.agents.transition;
		services.agents.transition = async (request) =>
			request.to === "on-call" ? undefined : transition(request);
	}
	let remainingReleaseFailures = options.releaseFailures ?? 0;
	let releaseReadUnavailable = false;
	if (remainingReleaseFailures > 0) {
		const transition = services.agents.transition;
		services.agents.transition = async (request) => {
			if (
				(request.to === "available" || request.to === "unavailable") &&
				remainingReleaseFailures > 0
			) {
				remainingReleaseFailures -= 1;
				releaseReadUnavailable = true;
				return undefined;
			}
			return transition(request);
		};
		const readState = services.agents.readState;
		services.agents.readState = async (orgId, agentId) => {
			if (releaseReadUnavailable) {
				releaseReadUnavailable = false;
				return { kind: "unavailable" };
			}
			return readState(orgId, agentId);
		};
	}
	let remainingWrapUpFailures = options.wrapUpFailures ?? 0;
	let remainingAfterCallAvailableFailures = options.afterCallAvailableFailures ?? 0;
	if (remainingWrapUpFailures > 0 || remainingAfterCallAvailableFailures > 0) {
		const transition = services.agents.transition;
		services.agents.transition = async (request) => {
			const current = services.agents.entries.get(request.agentId);
			const failWrapUp = request.to === "wrap-up" && remainingWrapUpFailures > 0;
			const failAvailable =
				request.to === "available" &&
				(current?.status === "on-call" || current?.status === "wrap-up") &&
				remainingAfterCallAvailableFailures > 0;
			if (failWrapUp) {
				remainingWrapUpFailures -= 1;
				releaseReadUnavailable = true;
				return undefined;
			}
			if (failAvailable) {
				remainingAfterCallAvailableFailures -= 1;
				releaseReadUnavailable = true;
				return undefined;
			}
			return transition(request);
		};
		const readState = services.agents.readState;
		services.agents.readState = async (orgId, agentId) => {
			if (releaseReadUnavailable) {
				releaseReadUnavailable = false;
				return { kind: "unavailable" };
			}
			return readState(orgId, agentId);
		};
	}

	const timeline: string[] = [];
	const notes: string[] = [];
	const dialled: QueueDialAttempt[][] = [];
	const script = [...(options.dials ?? [{ kind: "no-answer" as const }])];
	const pressed = [...(options.digits ?? [])];
	const state = { tearingDown: false, iterations: 0 };
	const budget = options.budget ?? 20;
	let onAgentLegEnded: (() => void) | undefined;
	const scheduledReleaseRetries: {
		readonly delayMs: number;
		readonly run: () => Promise<void>;
	}[] = [];

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
		// On the SAME timeline as `play` and `bridge`, deliberately: what an agent-whisper spec is
		// actually about is the ORDER — the agent hears their cue after the answer and before the
		// bridge — and a separate recorder would let a whisper played into a live conversation pass.
		playToAgent: async (mediaChannelId: string, media: string) => {
			timeline.push(`whisper:${mediaChannelId}:${media}`);
			if (options.whisperFails === true) {
				return false;
			}
			if (options.whisperThrows === true) {
				throw new Error("the media server refused the whisper");
			}
			return true;
		},
		startMusicOnHold: async (mohClass?: string) => {
			timeline.push(`moh:start${mohClass === undefined ? "" : `:${mohClass}`}`);
		},
		stopMusicOnHold: async () => {
			timeline.push("moh:stop");
			if (options.stopMusicThrows === true) {
				throw new Error("stop MOH failed");
			}
		},
		dial: async (attempts, fanOut, ringTimeoutSeconds): Promise<QueueDialOutcome> => {
			dialled.push([...attempts]);
			timeline.push(`dial:${fanOut}:${attempts.map((a) => a.agentId).join(",")}`);
			if (options.dialThrows === true) {
				throw new Error("dial failed");
			}
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
		hangupAnsweredAgent: async (mediaChannelId) => {
			timeline.push(`hangup:${mediaChannelId}`);
		},
		bridge: async (mediaChannelId, onEnded) => {
			timeline.push(`bridge:${mediaChannelId}`);
			onAgentLegEnded = onEnded;
			return options.bridgeFails !== true;
		},
		pollDigit: () => pressed.shift(),
		// On the SAME timeline as the bridge, for the reason the whisper is: what a recording spec is
		// about is the ORDER — the tap is taken after the two legs are joined, because there is
		// nothing to tap before that — and a separate recorder would let a recording started against a
		// bridge that never happened pass.
		startRecording: async () => {
			timeline.push("record:start");
			if (options.recordingThrows === true) {
				throw new Error("the media server refused a tap");
			}
			return options.recordingFails !== true;
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
		node,
		session: new QueueSession(node, call, services, {
			pollIntervalMs: 1_000,
			agentRingTimeoutSeconds: 20,
			random: () => 0,
			scheduleReleaseRetry: (callback, delayMs) => {
				scheduledReleaseRetries.push({ delayMs, run: callback });
			},
		}),
		services,
		timeline,
		dialled,
		notes,
		clock,
		scheduledReleaseRetries,
		runNextReleaseRetry: async () => {
			const retry = scheduledReleaseRetries.shift();
			if (retry === undefined) {
				throw new Error("no release retry is scheduled");
			}
			await retry.run();
		},
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

async function settleAgentLegHook(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
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

	it("records the call once the agent is bridged, when the policy asks for it", async () => {
		const h = harness({ node: { recordPolicy: "all" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		// The order is the assertion: a tap on a bridge that does not exist yet has nothing to tap.
		expect(h.timeline.indexOf("record:start")).toBeGreaterThan(
			h.timeline.indexOf("bridge:media-a"),
		);
	});

	it("records on `inbound`, because a queued call is inbound to the queue", async () => {
		const h = harness({ node: { recordPolicy: "inbound" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.timeline).toContain("record:start");
	});

	/**
	 * `on-demand` means the AGENT starts it, and a queue that pre-empted them would make the
	 * record-toggle feature code a no-op and the policy a lie.
	 */
	it("leaves `on-demand` and `outbound` to somebody else", async () => {
		for (const recordPolicy of ["on-demand", "outbound", "none"] as const) {
			const h = harness({ node: { recordPolicy }, dials: [{ kind: "answer" }] });
			await h.session.run();
			expect(h.timeline).not.toContain("record:start");
		}
	});

	it("connects the call anyway when the recording is refused, and says so", async () => {
		const h = harness({
			node: { recordPolicy: "all" },
			dials: [{ kind: "answer" }],
			recordingFails: true,
		});
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("answered");
		expect(h.notes.join(" ")).toContain("recording could not be started");
	});

	it("connects the call anyway when the recording THROWS, which is a different failure", async () => {
		const h = harness({
			node: { recordPolicy: "all" },
			dials: [{ kind: "answer" }],
			recordingThrows: true,
		});
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("answered");
		expect(h.notes.join(" ")).toContain("recording could not be started");
	});

	it("does not record a bridge that failed, because there is nothing to tap", async () => {
		const h = harness({
			node: { recordPolicy: "all" },
			dials: [{ kind: "answer" }],
			bridgeFails: true,
		});
		await h.session.run();
		expect(h.timeline).not.toContain("record:start");
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

	it("adopts an expired wrap-up reservation left by an old process", async () => {
		const h = harness({ agents: [fakeAgent("a")], dials: [{ kind: "answer" }] });
		h.services.agents.seed("a", "wrap-up", {
			callId: OTHER_CALL_ID,
			availableAt: new Date(START - 1).toISOString(),
		});

		const outcome = await h.session.run();

		expect(outcome).toMatchObject({ kind: "answered", agentId: "a" });
		expect(h.services.agents.transitions[0]).toMatchObject({
			agentId: "a",
			from: "wrap-up",
			to: "ringing",
			callId: CALL_ID,
		});
	});

	it("releases the reserved agent when stopping music throws", async () => {
		const h = harness({ stopMusicThrows: true });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("failed");
		expect(h.services.agents.statusOf("a")).toBe("available");
		expect(h.services.agents.transitions).toContainEqual({
			agentId: "a",
			from: "ringing",
			to: "available",
			callId: CALL_ID,
		});
	});

	it("releases the reserved agent when dial throws", async () => {
		const h = harness({ dialThrows: true });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("failed");
		expect(h.services.agents.statusOf("a")).toBe("available");
		expect(h.services.agents.transitions).toContainEqual({
			agentId: "a",
			from: "ringing",
			to: "available",
			callId: CALL_ID,
		});
	});

	it("retains and retries a reservation after transient KV unavailability", async () => {
		const h = harness({
			agents: [fakeAgent("a")],
			dials: [{ kind: "caller-gone" }],
			releaseFailures: 1,
		});

		await h.session.run();
		expect(h.services.agents.statusOf("a")).toBe("ringing");
		expect(h.scheduledReleaseRetries.map((retry) => retry.delayMs)).toEqual([250]);

		await h.runNextReleaseRetry();
		expect(h.services.agents.statusOf("a")).toBe("available");
		expect(h.scheduledReleaseRetries).toEqual([]);
	});

	it("uses one capped-backoff loop across repeated release failures", async () => {
		const h = harness({
			agents: [fakeAgent("a")],
			dials: [{ kind: "caller-gone" }],
			releaseFailures: 8,
		});

		await h.session.run();
		const delays: number[] = [];
		while (h.scheduledReleaseRetries.length > 0) {
			expect(h.scheduledReleaseRetries).toHaveLength(1);
			delays.push(h.scheduledReleaseRetries[0]?.delayMs as number);
			await h.runNextReleaseRetry();
		}

		expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("stops retrying without overwriting a reservation now owned by another call", async () => {
		const h = harness({
			agents: [fakeAgent("a")],
			dials: [{ kind: "caller-gone" }],
			releaseFailures: 1,
		});

		await h.session.run();
		h.services.agents.seed("a", "ringing", { callId: OTHER_CALL_ID });
		await h.runNextReleaseRetry();

		expect(h.services.agents.entries.get("a")).toMatchObject({
			status: "ringing",
			callId: OTHER_CALL_ID,
		});
		expect(h.scheduledReleaseRetries).toEqual([]);
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

	// ---------------------------------------------------------------------------------------------
	// The agent's whisper
	// ---------------------------------------------------------------------------------------------

	/**
	 * The cue an answering agent hears, and the caller does not.
	 *
	 * The whole feature is a matter of WHO and WHEN, so every assertion here is about the timeline
	 * rather than about a return value: played at the agent's own leg, after the answer is settled,
	 * before the bridge exists. A prompt one step later is a prompt the customer hears.
	 */
	it("plays the whisper at the AGENT's leg, after the answer and before the bridge", async () => {
		const h = harness({
			dials: [{ kind: "answer" }],
			node: { agentWhisperPromptId: "sales-cue" },
		});
		await h.session.run();

		const whisperAt = h.timeline.indexOf("whisper:media-a:sound:sales-cue");
		const bridgeAt = h.timeline.indexOf("bridge:media-a");
		expect(whisperAt).toBeGreaterThan(-1);
		expect(bridgeAt).toBeGreaterThan(whisperAt);
		// And never at the caller, who is still in the queue's hold music.
		expect(h.timeline).not.toContain("play:sound:sales-cue");
	});

	it("plays nothing when the queue has no whisper prompt", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.timeline.some((entry) => entry.startsWith("whisper:"))).toBe(false);
	});

	it("bridges anyway when the playback is refused — an announcement is worth less than the call", async () => {
		const h = harness({
			dials: [{ kind: "answer" }],
			node: { agentWhisperPromptId: "sales-cue" },
			whisperFails: true,
		});
		const outcome = await h.session.run();

		expect(outcome).toMatchObject({ kind: "answered", agentId: "a" });
		expect(h.timeline).toContain("bridge:media-a");
		expect(h.notes.join(" ")).toContain("could not be played");
	});

	it("bridges anyway when the playback THROWS, which is a different failure from a refusal", async () => {
		const h = harness({
			dials: [{ kind: "answer" }],
			node: { agentWhisperPromptId: "sales-cue" },
			whisperThrows: true,
		});
		const outcome = await h.session.run();

		expect(outcome).toMatchObject({ kind: "answered", agentId: "a" });
		expect(h.timeline).toContain("bridge:media-a");
		expect(h.notes.join(" ")).toContain("agent whisper prompt failed");
	});

	it("bridges anyway when the prompt id resolves to no playable audio", async () => {
		// The fake resolver answers `undefined` for a prompt it does not recognise, which is what the
		// walker's own resolver does for a `tts://` or an unmounted `object://` ref.
		const h = harness({
			dials: [{ kind: "answer" }],
			node: { agentWhisperPromptId: "   " },
		});
		const outcome = await h.session.run();

		expect(outcome).toMatchObject({ kind: "answered", agentId: "a" });
		expect(h.timeline.some((entry) => entry.startsWith("whisper:"))).toBe(false);
	});

	it("hangs up the answered leg and does not publish or bridge when on-call promotion fails", async () => {
		const h = harness({ dials: [{ kind: "answer" }], onCallTransitionFails: true });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("failed");
		expect(eventTypes(h)).toEqual(["caller.joined"]);
		expect(h.timeline).toContain("hangup:media-a");
		expect(h.timeline.some((entry) => entry.startsWith("bridge:"))).toBe(false);
		expect(h.services.agents.statusOf("a")).toBe("available");
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
	it("retries a transient on-call-to-wrap-up failure before starting its deadline", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 5 })],
			dials: [{ kind: "answer" }],
			wrapUpFailures: 1,
		});
		await h.session.run();
		h.endAgentLeg();
		await settleAgentLegHook();

		expect(h.services.agents.statusOf("a")).toBe("on-call");
		expect(h.scheduledReleaseRetries.map((retry) => retry.delayMs)).toEqual([250]);
		await h.runNextReleaseRetry();
		await Promise.resolve();

		expect(h.services.agents.transitions.some((transition) => transition.to === "wrap-up")).toBe(
			true,
		);
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("retries repeated wrap-up-to-available failures with capped backoff", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 5 })],
			dials: [{ kind: "answer" }],
			afterCallAvailableFailures: 8,
		});
		await h.session.run();
		h.endAgentLeg();
		await settleAgentLegHook();

		const delays: number[] = [];
		while (h.scheduledReleaseRetries.length > 0) {
			expect(h.scheduledReleaseRetries).toHaveLength(1);
			delays.push(h.scheduledReleaseRetries[0]?.delayMs as number);
			await h.runNextReleaseRetry();
		}

		expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("retries a transient direct on-call-to-available failure", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0 },
			dials: [{ kind: "answer" }],
			afterCallAvailableFailures: 1,
		});
		await h.session.run();
		h.endAgentLeg();
		await settleAgentLegHook();

		expect(h.services.agents.statusOf("a")).toBe("on-call");
		expect(h.scheduledReleaseRetries.map((retry) => retry.delayMs)).toEqual([250]);
		await h.runNextReleaseRetry();
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

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
		expect(h.services.waiting.waitingCount).toBe(0);
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

// =================================================================================================
// Exit keys
// =================================================================================================

/**
 * A waiting caller pressing a key to leave.
 *
 * The digit source in the harness is a queue drained one entry per `pollDigit`, which is exactly
 * what the walker's signal watch produces: the session sees at most one digit per pass, and the
 * ones it does not want are left alone.
 */
describe("exit keys", () => {
	it("leaves the queue on the configured digit", async () => {
		const h = harness({ node: { exitKey: "9" }, digits: ["9"] });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("exit-key");
		expect(h.dialled).toEqual([]);
	});

	it("stops the hold music before handing the caller on", async () => {
		const h = harness({ node: { exitKey: "9" }, digits: ["9"] });
		await h.session.run();
		expect(h.timeline[h.timeline.length - 1]).toBe("moh:stop");
	});

	it("publishes an abandonment the SLA can tell apart from a timeout", async () => {
		const h = harness({ node: { exitKey: "9" }, digits: ["9"] });
		await h.session.run();
		const abandoned = h.services.events.recorded.find((event) => event.type === "caller.abandoned");
		expect(abandoned?.data.reason).toBe("exit-key");
		expect(abandoned?.data.exitKey).toBe("9");
	});

	it("ignores a digit that is not the exit key, and keeps distributing", async () => {
		const h = harness({ node: { exitKey: "9" }, digits: ["4"], dials: [{ kind: "answer" }] });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("answered");
	});

	it("does nothing at all for a queue with no exit key", async () => {
		const h = harness({ digits: ["9"], dials: [{ kind: "answer" }] });
		const outcome = await h.session.run();
		expect(outcome.kind).toBe("answered");
	});

	/** A tenant who typed `d` gets the DTMF `D`; the compiler upper-cases, and so does this. */
	it("matches case-insensitively, so a letter key works whichever way it was typed", async () => {
		const h = harness({ node: { exitKey: "D" }, digits: ["d"] });
		expect((await h.session.run()).kind).toBe("exit-key");
	});

	it("does not hold a place for a caller who chose to leave", async () => {
		const h = harness({
			node: { exitKey: "9", abandonedResumeAllowed: true, discardAbandonedAfterSeconds: 60 },
			digits: ["9"],
		});
		await h.session.run();
		expect(h.services.waiting.waitingCount).toBe(0);
	});
});

// =================================================================================================
// The shared line: position, priority and resume
// =================================================================================================

describe("the shared waiting line", () => {
	it("reports the caller's real position on `caller.joined`", async () => {
		const h = harness({ dials: [{ kind: "answer" }] });
		await h.session.run();
		const joined = h.services.events.recorded.find((event) => event.type === "caller.joined");
		expect(joined?.data.position).toBe(1);
	});

	it("carries the node's priority onto the event, instead of the constant 0 it used to", async () => {
		const h = harness({ node: { priority: 800 }, dials: [{ kind: "answer" }] });
		await h.session.run();
		const joined = h.services.events.recorded.find((event) => event.type === "caller.joined");
		expect(joined?.data.priority).toBe(800);
	});

	/**
	 * The admission gate, from the low-priority caller's side. One free agent and somebody ahead of
	 * them in the shared line means they wait — which is what makes priority a priority rather than
	 * a field on an event.
	 */
	it("holds a caller back while somebody ahead of them is unserved and only one agent is free", async () => {
		const h = harness({ agents: [fakeAgent("a")], budget: 3 });
		// Somebody else is already in the line, at a higher priority, on another instance.
		await h.services.waiting.join({
			orgId: ORG,
			queueId: h.node.queueId,
			callId: OTHER_CALL_ID,
			legId: LEG_ID,
			priority: 900,
			instanceId: "engine-2",
			now: h.clock.now,
			resumeAllowed: false,
		});
		await h.session.run();
		expect(h.dialled).toEqual([]);
	});

	/**
	 * …and the bound, from the other side. Three free agents means the first three in the line may
	 * all ring at once. A turnstile that only let rank 1 offer would turn an instant answer for three
	 * people into a three-second staircase, precisely during the spike that made three people call.
	 */
	it("lets a caller ring when there are as many free agents as there are people ahead of them", async () => {
		const h = harness({
			agents: [fakeAgent("a"), fakeAgent("b", { position: 2 }), fakeAgent("c", { position: 3 })],
			dials: [{ kind: "answer" }],
		});
		await h.services.waiting.join({
			orgId: ORG,
			queueId: h.node.queueId,
			callId: OTHER_CALL_ID,
			legId: LEG_ID,
			priority: 900,
			instanceId: "engine-2",
			now: h.clock.now,
			resumeAllowed: false,
		});
		expect((await h.session.run()).kind).toBe("answered");
	});

	it("holds a place for a caller who hung up, when the queue allows it", async () => {
		const h = harness({
			node: { abandonedResumeAllowed: true, discardAbandonedAfterSeconds: 60 },
			dials: [{ kind: "caller-gone" }],
		});
		await h.session.run();
		const claimed = await h.services.waiting.join({
			orgId: ORG,
			queueId: h.node.queueId,
			callId: OTHER_CALL_ID,
			legId: LEG_ID,
			priority: 0,
			callerNumber: "+15551234567",
			instanceId: "engine-1",
			now: h.clock.now,
			resumeAllowed: true,
		});
		expect(claimed.resumed).toBe(true);
	});

	it("holds no place when the queue does not allow resuming", async () => {
		const h = harness({ dials: [{ kind: "caller-gone" }] });
		await h.session.run();
		const claimed = await h.services.waiting.join({
			orgId: ORG,
			queueId: h.node.queueId,
			callId: OTHER_CALL_ID,
			legId: LEG_ID,
			priority: 0,
			callerNumber: "+15551234567",
			instanceId: "engine-1",
			now: h.clock.now,
			resumeAllowed: true,
		});
		expect(claimed.resumed).toBe(false);
	});

	/** A caller an agent answered did not lose their place; there is nothing to hold. */
	it("holds no place for a caller who was answered", async () => {
		const h = harness({
			node: { abandonedResumeAllowed: true, discardAbandonedAfterSeconds: 60 },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		const claimed = await h.services.waiting.join({
			orgId: ORG,
			queueId: h.node.queueId,
			callId: OTHER_CALL_ID,
			legId: LEG_ID,
			priority: 0,
			callerNumber: "+15551234567",
			instanceId: "engine-1",
			now: h.clock.now,
			resumeAllowed: true,
		});
		expect(claimed.resumed).toBe(false);
	});
});

// =================================================================================================
// Per-tier announcements
// =================================================================================================

describe("per-tier agent announcements", () => {
	it("plays the tier's prompt to the agent instead of the queue's", async () => {
		const h = harness({
			node: { agentWhisperPromptId: "queue-prompt" },
			agents: [fakeAgent("a", { announcePromptId: "tier-prompt" })],
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		expect(h.timeline).toContain("whisper:media-a:sound:tier-prompt");
		expect(h.timeline).not.toContain("whisper:media-a:sound:queue-prompt");
	});

	it("falls back to the queue's whisper for an agent whose tier has none", async () => {
		const h = harness({
			node: { agentWhisperPromptId: "queue-prompt" },
			agents: [fakeAgent("a")],
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		expect(h.timeline).toContain("whisper:media-a:sound:queue-prompt");
	});

	it("whispers nothing when neither the tier nor the queue has a prompt", async () => {
		const h = harness({ agents: [fakeAgent("a")], dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.timeline.some((entry) => entry.startsWith("whisper:"))).toBe(false);
	});
});
