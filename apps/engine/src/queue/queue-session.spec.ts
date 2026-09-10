import { describe, expect, it } from "bun:test";
import { queueNode } from "../routing/plan-fixtures.fake";
import { fakeAgent, fakeMembership, makeFakeQueueServices } from "./queue-services.fake";
import { penaltySecondsFor, QueueSession } from "./queue-session";
import type { FakeQueueServices } from "./queue-services.fake";
import type { QueueCallPort, QueueDialAttempt, QueueDialOutcome } from "./queue-session";
import type { AgentStateEntry, QueueMembership, QueueMembershipAgent } from "@optimiq-voice/events";
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
	/** `null` withholds the caller's number — the case virtual hold cannot promise anything to. */
	readonly callerNumber?: string | null;
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
	/** The caller went with the agent: the walker's detach resolves `false` and no survey is asked. */
	readonly callerDetachFails?: boolean;
}

interface Harness {
	readonly session: QueueSession;
	readonly node: QueuePlanNode;
	readonly services: FakeQueueServices;
	/** Queues the session told the callback sweep about. */
	readonly registered: readonly { readonly orgId: string; readonly queueId: string }[];
	readonly timeline: string[];
	/** What each `startRecording` was asked for — the per-queue PCI auto-pause flag, or nothing. */
	readonly recordingRequests: ({ readonly autoPauseOnDtmf?: boolean } | undefined)[];
	readonly dialled: QueueDialAttempt[][];
	readonly notes: string[];
	readonly clock: { now: number };
	readonly scheduledReleaseRetries: readonly { readonly delayMs: number }[];
	runNextReleaseRetry(): Promise<void>;
	/** Fires the wrap-up hook the bridge registered, as the agent leg's death would. */
	endAgentLeg(): void;
	/** Queues digits for the caller to press, as the signal watch would feed them. */
	press(...digits: readonly string[]): void;
	/** What each `bridge` call asked for — `keepCallerOnPeerEnd` when the queue has a survey. */
	readonly bridgeOptions: ({ readonly keepCallerOnPeerEnd?: boolean } | undefined)[];
	/** How many times the session released the caller's own leg through `endCaller`. */
	readonly callersEnded: { count: number };
	/** The caller's digit source: whether it is still fed, and how often it was closed. */
	readonly digits: { open: boolean; released: number };
	/** Agent-state point reads the session made. The disposition poll is the only source of them. */
	readonly stateReads: { count: number };
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

	const stateReads = { count: 0 };
	{
		const readState = services.agents.readState;
		services.agents.readState = async (orgId, agentId) => {
			stateReads.count += 1;
			return readState(orgId, agentId);
		};
	}

	const registered: { orgId: string; queueId: string }[] = [];
	services.callbacks = {
		register: (orgId, queueId) => {
			registered.push({ orgId, queueId });
		},
	};

	const timeline: string[] = [];
	const recordingRequests: ({ readonly autoPauseOnDtmf?: boolean } | undefined)[] = [];
	const notes: string[] = [];
	const dialled: QueueDialAttempt[][] = [];
	const script = [...(options.dials ?? [{ kind: "no-answer" as const }])];
	const pressed = [...(options.digits ?? [])];
	const state = { tearingDown: false, iterations: 0 };
	const budget = options.budget ?? 20;
	let onAgentLegEnded: ((detached: Promise<boolean>) => void) | undefined;
	/** What `bridge` was asked to do with the caller when the agent leg ends. */
	const bridgeOptions: ({ readonly keepCallerOnPeerEnd?: boolean } | undefined)[] = [];
	/** Legs the walker released through `endCaller` — the survey's own cleanup. */
	const callersEnded = { count: 0 };
	/**
	 * The digit source's own lifetime, modelled as the walker implements it: one signal-bus watch
	 * that stops feeding the array the moment it is released. A fake that ignored `releaseDigits`
	 * would poll happily after the source was closed — which is exactly how the survey's digits went
	 * missing live while every spec passed.
	 */
	const digits = { open: true, released: 0 };
	/** What the fake's `detached` promise resolves to; `true` is a caller kept out of the bridge. */
	const detachOutcome = { value: options.callerDetachFails === true ? false : true };
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
		...(options.callerNumber === null
			? {}
			: { callerNumber: options.callerNumber ?? "+15551234567" }),
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
		bridge: async (mediaChannelId, onEnded, bridgeOpts) => {
			timeline.push(`bridge:${mediaChannelId}`);
			bridgeOptions.push(bridgeOpts);
			onAgentLegEnded = onEnded;
			return options.bridgeFails !== true;
		},
		endCaller: async () => {
			timeline.push("caller:end");
			callersEnded.count += 1;
			await Promise.resolve();
		},
		pollDigit: () => (digits.open ? pressed.shift() : undefined),
		releaseDigits: () => {
			digits.open = false;
			digits.released += 1;
			pressed.length = 0;
		},
		// On the SAME timeline as the bridge, for the reason the whisper is: what a recording spec is
		// about is the ORDER — the tap is taken after the two legs are joined, because there is
		// nothing to tap before that — and a separate recorder would let a recording started against a
		// bridge that never happened pass.
		startRecording: async (request) => {
			timeline.push("record:start");
			recordingRequests.push(request);
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
		registered,
		timeline,
		recordingRequests,
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
			onAgentLegEnded?.(Promise.resolve(detachOutcome.value));
		},
		press: (...digits) => {
			pressed.push(...digits);
		},
		bridgeOptions,
		callersEnded,
		digits,
		stateReads,
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

	/**
	 * PCI. The per-queue column was compiled and read by nothing: the orchestrator resolves
	 * auto-pause from `extensionsByNumber[destination]`, and a queue number is not an extension, so
	 * a queue that asked for auto-pause got the organization default instead of its own answer.
	 */
	it("carries the queue's own DTMF auto-pause flag into the recording request", async () => {
		for (const recordAutoPauseOnDtmf of [true, false] as const) {
			const h = harness({
				node: { recordPolicy: "all", recordAutoPauseOnDtmf },
				dials: [{ kind: "answer" }],
			});
			await h.session.run();
			expect(h.recordingRequests).toEqual([{ autoPauseOnDtmf: recordAutoPauseOnDtmf }]);
		}
	});

	/**
	 * `undefined` is not `false`. A queue with no opinion must leave the organization-wide setting
	 * standing, which is what an empty request means to the orchestrator.
	 */
	it("asks for nothing when the queue has no auto-pause opinion", async () => {
		const h = harness({ node: { recordPolicy: "all" }, dials: [{ kind: "answer" }] });
		await h.session.run();
		expect(h.recordingRequests).toEqual([{}]);
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
	it("carries a logical extension number separately from the media endpoint", async () => {
		const h = harness({
			agents: [fakeAgent("a", { contact: "PJSIP/1002", extensionNumber: "1002" })],
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		expect(h.dialled[0]?.[0]?.endpoint).toBe("PJSIP/1002");
		expect(h.dialled[0]?.[0]?.destinationNumber).toBe("1002");
	});

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

	it("gives up rather than retrying a permanently unreadable bucket forever", async () => {
		// `retry` is what an unreadable bucket answers, so an unconfigured view would otherwise leave
		// one unref'd timer per agent per session alive for the life of the process, each holding the
		// session graph. The agent's own `availableAt` deadline makes them eligible again anyway.
		const h = harness({
			agents: [fakeAgent("a")],
			dials: [{ kind: "caller-gone" }],
			releaseFailures: 1_000,
		});

		await h.session.run();
		let scheduled = 0;
		while (h.scheduledReleaseRetries.length > 0) {
			scheduled += 1;
			expect(scheduled).toBeLessThan(100);
			await h.runNextReleaseRetry();
		}

		expect(scheduled).toBe(30);
		expect(h.notes.join(" ")).toContain("giving up");
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

	it("penalises only the agent the cause belongs to on a ring-all", async () => {
		// A fanned-out `failed` carries ONE leg's cause. Charging it to every reserved agent lets one
		// person pressing decline bench the whole tier with a reject delay.
		const h = harness({
			node: { strategy: "ring-all" },
			agents: [
				fakeAgent("a", { rejectDelaySeconds: 90 }),
				fakeAgent("b", { rejectDelaySeconds: 90 }),
			],
			dials: [{ kind: "reject" }],
			budget: 2,
		});
		await h.session.run();
		const releaseOf = (agentId: string) =>
			h.services.agents.transitions.find(
				(transition) => transition.agentId === agentId && transition.to === "available",
			);
		expect(releaseOf("a")?.availableAt).toBe(START + 20_000 + 90_000);
		expect(releaseOf("b")?.availableAt).toBeUndefined();
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

	it("omits the position entirely when the line was never readable", async () => {
		// A floor of 1 here would fill the SLA report with abandonments "at position 1" that are
		// really KV read failures — the exact confusion `position: 0` was introduced to remove.
		const h = harness({ seed: { a: "on-call", b: "on-call" }, budget: 2 });
		const unknown = { position: 0, waiting: 0, longestWaitMs: 0, resumed: false, joinedAt: 0 };
		h.services.waiting.join = async () => unknown;
		h.services.waiting.refresh = async () => unknown;
		await h.session.run();
		expect(eventData(h, "caller.abandoned")).not.toHaveProperty("position");
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

// =================================================================================================
// Virtual hold
// =================================================================================================

/**
 * The caller's half of the callback: they are offered one, they take it, and their place is written
 * as a token the platform owes a call on. The dialling half is `queue-callback.spec.ts`.
 */
describe("virtual hold", () => {
	const callback = (overrides = {}) => ({
		key: "2",
		offerAfterSeconds: 0,
		offerPromptId: "callback-offer",
		confirmPromptId: "callback-confirm",
		maxAttempts: 3,
		retryDelaySeconds: 300,
		expiresAfterSeconds: 3600,
		...overrides,
	});

	it("takes the caller out of the line on the accept key", async () => {
		const h = harness({ node: { callback: callback() }, digits: ["2"] });
		const outcome = await h.session.run();

		expect(outcome.kind).toBe("callback");
		expect(h.dialled).toEqual([]);
		expect(h.services.waiting.waitingCount).toBe(0);
	});

	it("stops the hold music and plays the confirmation before ending the call", async () => {
		const h = harness({ node: { callback: callback() }, digits: ["2"] });
		await h.session.run();

		expect(h.timeline).toContain("moh:stop");
		expect(h.timeline).toContain("play:sound:callback-confirm");
	});

	/**
	 * Its own reason, not `caller-hangup`: an SLA that counted a caller taking the offer as one
	 * giving up would penalise the queue for the feature working.
	 */
	it("publishes an abandonment a report can tell apart from a caller giving up", async () => {
		const h = harness({ node: { callback: callback() }, digits: ["2"] });
		await h.session.run();
		const abandoned = h.services.events.recorded.find((event) => event.type === "caller.abandoned");
		expect(abandoned?.data.reason).toBe("callback");
	});

	it("writes a token the platform owes a call on, keyed by the caller's number", async () => {
		const h = harness({ node: { callback: callback() }, digits: ["2"] });
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
		// The token IS a resume promise: a caller who rings back first claims their own place, which
		// is what stops the platform calling somebody who is already back in the line.
		expect(claimed.resumed).toBe(true);
	});

	it("announces the offer once the caller has waited long enough, and only once", async () => {
		const h = harness({
			node: { callback: callback({ offerAfterSeconds: 1 }) },
			dials: [{ kind: "no-answer" }, { kind: "no-answer" }, { kind: "answer" }],
		});
		await h.session.run();

		expect(h.timeline.filter((entry) => entry === "play:sound:callback-offer")).toHaveLength(1);
	});

	it("never announces an offer the queue has no wait for", async () => {
		const h = harness({ node: { callback: callback() }, dials: [{ kind: "answer" }] });
		await h.session.run();

		expect(h.timeline).not.toContain("play:sound:callback-offer");
	});

	it("leaves the caller in the queue when they press the key with no number to call back", async () => {
		const h = harness({
			node: { callback: callback() },
			digits: ["2"],
			callerNumber: null,
			dials: [{ kind: "answer" }],
		});
		const outcome = await h.session.run();

		expect(outcome.kind).toBe("answered");
		expect(h.notes.join(" ")).toContain("presented no number");
	});

	it("does nothing at all for a queue that offers no callback", async () => {
		const h = harness({ digits: ["2"], dials: [{ kind: "answer" }] });
		expect((await h.session.run()).kind).toBe("answered");
	});

	/** One poll per pass: the exit key must not eat the digit meant for the callback offer. */
	it("tells the two keys apart on one polled digit", async () => {
		const h = harness({ node: { exitKey: "9", callback: callback() }, digits: ["2"] });
		expect((await h.session.run()).kind).toBe("callback");
	});

	/**
	 * The dialler is a sweep, and a sweep only runs for a queue it has been told about. Registering
	 * happens AFTER the write, so the platform never looks for a promise that failed to persist.
	 */
	it("starts the dialling sweep for the queue it just made a promise on", async () => {
		const h = harness({ node: { callback: callback() }, digits: ["2"] });
		await h.session.run();

		expect(h.registered).toEqual([{ orgId: ORG, queueId: h.node.queueId }]);
	});

	it("starts no sweep for a caller who merely hung up", async () => {
		const h = harness({ node: { callback: callback() }, budget: 2 });
		await h.session.run();

		expect(h.registered).toEqual([]);
	});

	/**
	 * The other end of the token, read back through the REAL store: what the caller's half wrote is
	 * exactly what the sweep reads, including the queued call that links the two CDRs.
	 */
	it("writes a token the sweep can read, carrying the call it settles", async () => {
		const h = harness({ node: { callback: callback() }, digits: ["2"] });
		await h.session.run();

		const due = await h.services.waiting.dueCallbacks(ORG, h.node.queueId, h.clock.now);
		expect(due).toHaveLength(1);
		expect(due[0]?.callerNumber).toBe("+15551234567");
		expect(due[0]?.callback?.callId).toBe(CALL_ID);

		// One failed attempt, and the token is still owed two more.
		expect(
			await h.services.waiting.deferCallback(ORG, h.node.queueId, "+15551234567", h.clock.now, 0),
		).toBe(false);
		const again = await h.services.waiting.dueCallbacks(ORG, h.node.queueId, h.clock.now);
		expect(again[0]?.callback?.attempts).toBe(1);
	});
});

// =================================================================================================
// RONA
// =================================================================================================

describe("RONA", () => {
	it("leaves a queue without it on the consecutive-count model", async () => {
		const h = harness({
			agents: [
				fakeAgent("a", { maxNoAnswer: 3, noAnswerDelaySeconds: 30 }),
				fakeAgent("b", { position: 2 }),
			],
			dials: [{ kind: "no-answer" }, { kind: "answer" }],
		});
		await h.session.run();
		const release = h.services.agents.transitions.find(
			(transition) => transition.agentId === "a" && transition.to === "available",
		);
		expect(release).toMatchObject({ from: "ringing", noAnswerCount: 1 });
		expect(release?.reason).toBeUndefined();
		expect(h.services.agents.statusOf("a")).toBe("available");
	});

	it("benches the agent on ONE no-answer when the queue has it on", async () => {
		const h = harness({
			agents: [fakeAgent("a", { maxNoAnswer: 3 }), fakeAgent("b", { position: 2 })],
			membership: { ronaEnabled: true },
			dials: [{ kind: "no-answer" }, { kind: "answer" }],
		});
		const outcome = await h.session.run();

		expect(outcome).toMatchObject({ kind: "answered", agentId: "b" });
		const benched = h.services.agents.transitions.find(
			(transition) => transition.agentId === "a" && transition.to === "unavailable",
		);
		expect(benched).toMatchObject({ from: "ringing", reason: "rona" });
		expect(h.notes.join(" ")).toContain("RONA");
	});

	it("offers the caller to the next agent and never back to the benched one", async () => {
		const h = harness({
			agents: [fakeAgent("a"), fakeAgent("b", { position: 2 })],
			membership: { ronaEnabled: true },
			dials: [{ kind: "no-answer" }, { kind: "answer" }],
		});
		await h.session.run();
		expect(h.dialled.map((attempt) => attempt.map((entry) => entry.agentId))).toEqual([
			["a"],
			["b"],
		]);
	});

	it("still uses the busy penalty for a busy phone, and does not bench it", async () => {
		const h = harness({
			agents: [fakeAgent("a", { busyDelaySeconds: 60 }), fakeAgent("b", { position: 2 })],
			membership: { ronaEnabled: true },
			dials: [{ kind: "busy" }, { kind: "answer" }],
		});
		await h.session.run();
		const release = h.services.agents.transitions.find(
			(transition) => transition.agentId === "a" && transition.to === "available",
		);
		// A busy phone is on another call, not unanswered — so no count, no bench, just the delay.
		expect(release?.noAnswerCount).toBeUndefined();
		expect(release?.availableAt).toBe(START + 20_000 + 60_000);
		expect(
			h.services.agents.transitions.some(
				(transition) => transition.agentId === "a" && transition.to === "unavailable",
			),
		).toBe(false);
	});
});

// =================================================================================================
// Wrap-up dispositions
// =================================================================================================

const CODES = [
	{
		id: "0195c0f0-1c2f-7000-8000-0000000000d1",
		code: "sale",
		label: "Sale",
		position: 1,
	},
];

async function settle(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

describe("wrap-up dispositions", () => {
	it("carries the call being coded and the queue's insistence into the wrap-up write", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 10 })],
			membership: { dispositionCodes: CODES, dispositionRequired: true },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		await Promise.resolve();
		const wrapUp = h.services.agents.transitions.find((transition) => transition.to === "wrap-up");
		expect(wrapUp).toMatchObject({ dispositionCallId: CALL_ID, dispositionRequired: true });
	});

	it("sets no disposition fields at all for a queue that asks no question", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 10 })],
			membership: { dispositionRequired: true },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		await Promise.resolve();
		const wrapUp = h.services.agents.transitions.find((transition) => transition.to === "wrap-up");
		expect(wrapUp?.dispositionCallId).toBeUndefined();
		expect(wrapUp?.dispositionRequired).toBeUndefined();
		expect(h.services.afterCall.dispositions).toEqual([]);
	});

	it("ends wrap-up the moment a required code is picked, rather than at the deadline", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 30 })],
			membership: { dispositionCodes: CODES, dispositionRequired: true },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		const answeredAt = h.clock.now;
		h.endAgentLeg();
		await Promise.resolve();
		// The console's write, which is the API's and not the engine's — hence straight onto the entry.
		const entry = h.services.agents.entries.get("a") as AgentStateEntry;
		h.services.agents.entries.set("a", { ...entry, dispositionCode: "sale" });
		await settle();

		expect(h.services.agents.statusOf("a")).toBe("available");
		expect(h.services.afterCall.dispositions).toEqual([
			{
				orgId: ORG,
				queueId: h.node.queueId,
				callId: CALL_ID,
				agentId: "a",
				code: "sale",
				auto: false,
			},
		]);
		// One poll interval, not the whole thirty seconds.
		expect(h.clock.now).toBe(answeredAt + 1_000);
	});

	it("files `unset` at the deadline when nobody codes the call", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 5 })],
			membership: { dispositionCodes: CODES, dispositionRequired: true },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		const answeredAt = h.clock.now;
		h.endAgentLeg();
		await settle();

		expect(h.services.afterCall.dispositions).toMatchObject([{ code: "unset", auto: true }]);
		expect(h.services.agents.statusOf("a")).toBe("available");
		expect(h.clock.now).toBe(answeredAt + 5_000);
	});

	it("never polls the agent's entry for a queue that does not insist", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 5 })],
			membership: { dispositionCodes: CODES, dispositionRequired: false },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		const before = h.stateReads.count;
		h.endAgentLeg();
		await settle();

		expect(h.stateReads.count).toBe(before);
		expect(h.services.afterCall.dispositions).toEqual([]);
		expect(h.services.agents.statusOf("a")).toBe("available");
	});
});

// =================================================================================================
// The post-call survey
// =================================================================================================

const SURVEY = {
	introPromptId: "0195c0f0-1c2f-7000-8000-0000000000e0",
	questions: [
		{
			id: "0195c0f0-1c2f-7000-8000-0000000000f1",
			position: 1 as const,
			promptId: "0195c0f0-1c2f-7000-8000-0000000000f9",
			label: "How did we do?",
		},
	],
};

describe("the post-call survey", () => {
	it("asks the caller once the agent's leg has gone and reports what they pressed", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.press("4");
		h.endAgentLeg();
		await settle();

		expect(h.timeline).toContain("play:sound:0195c0f0-1c2f-7000-8000-0000000000e0");
		expect(h.services.afterCall.surveys).toMatchObject([
			{
				callId: CALL_ID,
				agentId: "a",
				answers: [{ questionId: SURVEY.questions[0]?.id, digit: "4" }],
			},
		]);
	});

	/**
	 * The defect this closes: the agent's hangup tore the bridge down AND hung the caller up, so
	 * there was nobody left to ask. The queue now asks for the caller to be kept out of the bridge —
	 * and only when it actually has a survey, because a kept caller with nothing to say to them is a
	 * call that never ends.
	 */
	it("asks for the caller to be kept out of the bridge, and only when there is a survey", async () => {
		const withSurvey = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
		});
		await withSurvey.session.run();
		expect(withSurvey.bridgeOptions).toEqual([{ keepCallerOnPeerEnd: true }]);

		const without = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0 },
			dials: [{ kind: "answer" }],
		});
		await without.session.run();
		expect(without.bridgeOptions).toEqual([{}]);
	});

	/**
	 * The other half of asking for a kept caller: a leg detached for a survey has nobody left to end
	 * it, so the survey owns releasing it — on every exit, including the ones that report nothing.
	 */
	it("releases the caller's own leg once the survey is over", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.press("4");
		h.endAgentLeg();
		await settle();

		expect(h.callersEnded.count).toBe(1);
		// The order is the assertion: the caller is released AFTER the questions, not instead of them.
		expect(h.timeline.indexOf("caller:end")).toBeGreaterThan(
			h.timeline.indexOf("play:sound:0195c0f0-1c2f-7000-8000-0000000000e0"),
		);
	});

	/**
	 * The defect the live run found, and the reason the fake above models the source's lifetime: the
	 * walker closed the caller's DTMF watch in a `finally` around `run`, which returns the moment the
	 * caller is BRIDGED — minutes before the survey polls it. Every keypress an answering caller made
	 * went to a source nobody was watching, and `queue_survey_response` stayed empty for the feature's
	 * whole history while these specs passed.
	 */
	it("keeps the caller's digit source open past `run`, and closes it once the survey is over", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		// Still open with the call up: the questions have not been asked yet.
		expect(h.digits).toMatchObject({ open: true, released: 0 });

		h.press("4");
		h.endAgentLeg();
		await settle();

		expect(h.digits).toMatchObject({ open: false, released: 1 });
		expect(h.services.afterCall.surveys).toMatchObject([
			{ answers: [{ questionId: SURVEY.questions[0]?.id, digit: "4" }] },
		]);
	});

	it("closes the digit source with the session when the queue has no survey", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0 },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();

		expect(h.digits).toMatchObject({ open: false, released: 1 });
	});

	/** A survey that never gets to ask anything still owns closing the source it was left open for. */
	it("closes the digit source when the caller went with the agent", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
			callerDetachFails: true,
		});
		await h.session.run();
		expect(h.digits.open).toBe(true);

		h.endAgentLeg();
		await settle();

		expect(h.digits).toMatchObject({ open: false, released: 1 });
		expect(h.services.afterCall.surveys).toEqual([]);
	});

	it("releases the caller even when they answered nothing", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		await settle();

		expect(h.services.afterCall.surveys).toEqual([]);
		expect(h.callersEnded.count).toBe(1);
	});

	/**
	 * The caller went with the agent after all — a media plane that could not detach them, or a
	 * caller who hung up in the same instant. Nothing is played into a bridge that is still standing,
	 * and the walk says why.
	 */
	it("asks nothing when the caller could not be kept, and says so", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0, survey: SURVEY },
			dials: [{ kind: "answer" }],
			callerDetachFails: true,
		});
		await h.session.run();
		h.press("4");
		h.endAgentLeg();
		await settle();

		expect(h.timeline).not.toContain("play:sound:0195c0f0-1c2f-7000-8000-0000000000e0");
		expect(h.services.afterCall.surveys).toEqual([]);
		expect(h.notes.join(" ")).toContain("went with the agent's");
	});

	/**
	 * The wrap-up must not wait on the detach. An agent's after-call timer starts when their call
	 * ended, not two media-server round trips later.
	 */
	it("starts the agent's wrap-up without waiting for the caller's detach", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 30 })],
			membership: { wrapUpSeconds: 30, survey: SURVEY },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.endAgentLeg();
		// The AGENT-leg hook settle only: one microtask drain, not the survey's whole run. If the
		// wrap-up waited on the detach it would not have happened yet at this point.
		await settleAgentLegHook();

		expect(h.services.agents.transitions.some((transition) => transition.to === "wrap-up")).toBe(
			true,
		);
	});

	it("asks nothing at all when the queue has no survey", async () => {
		const h = harness({
			agents: [fakeAgent("a", { wrapUpSeconds: 0 })],
			membership: { wrapUpSeconds: 0 },
			dials: [{ kind: "answer" }],
		});
		await h.session.run();
		h.press("4");
		h.endAgentLeg();
		await settle();

		expect(h.services.afterCall.surveys).toEqual([]);
	});
});

// =================================================================================================
// Skills
// =================================================================================================

describe("skills-based routing", () => {
	it("rings only the agent who clears the merged bar, and notes when nobody does", async () => {
		const h = harness({
			agents: [
				fakeAgent("a", { skills: [{ skill: "spanish", level: 2 }] }),
				fakeAgent("b", { position: 2, skills: [{ skill: "spanish", level: 5 }] }),
			],
			membership: {
				tierRulesApply: false,
				skillRequirements: [{ skill: "spanish", minLevel: 3, relaxAfterSeconds: 0 }],
			},
			node: { requiredSkills: [{ skill: "spanish", minLevel: 5, relaxAfterSeconds: 0 }] },
			dials: [{ kind: "answer" }],
		});
		const outcome = await h.session.run();
		expect(outcome).toMatchObject({ kind: "answered", agentId: "b" });
	});

	it("says so on the walk when the skills are the only reason nobody was reachable", async () => {
		const h = harness({
			agents: [fakeAgent("a", { skills: [{ skill: "spanish", level: 1 }] })],
			membership: {
				tierRulesApply: false,
				skillRequirements: [{ skill: "spanish", minLevel: 5, relaxAfterSeconds: 0 }],
			},
			node: { maxWaitSeconds: 5 },
		});
		await h.session.run();
		const notes = h.notes.filter((note) => note.includes("skill requirements"));
		// Once per stay, not once per pass.
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("spanish>=5");
	});
});
