import { describe, expect, it } from "bun:test";
import { MediaOperationNotSupportedError } from "../media/media-not-supported.error";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { extensionNode, hangupNode, planOf, trunkDialNode } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { MediaPort, PlayRequest } from "../media/media-port";
import type { OriginatedLeg, PlanWalkerSettings, WalkerChannel, WalkInput } from "./plan-walker";
import type { FollowMeDestination, FollowMePlan, PlanNode } from "@optimiq-voice/routing";
import type { HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * Answer confirmation — "press 1 to accept this call" — as the plan walker runs it.
 *
 * ## What is actually being tested
 *
 * One fact, from six directions: an unconfirmed leg is NEVER bridged. The reason the feature exists
 * is that a follow-me hop to a mobile is answered by whichever of two things gets there first — the
 * person, or the carrier's voicemail — and both look identical to a switch. So every way the
 * question can fail to be answered must land the call exactly where a phone that rang out would
 * have: on the next hop, and eventually in the tenant's OWN mailbox.
 *
 * ## How the harness presses a digit
 *
 * From inside `play`, on a timer. That is not incidental: the walker installs its DTMF watcher and
 * then plays the prompt, so a digit emitted from the play call is the first moment a real phone
 * could have heard the question — and a `setTimeout(0)` lands after the walker has resumed from the
 * playback and armed its collector, which a microtask would not. Emitting on the answer instead
 * would race the subscription and make these specs flaky for a reason that has nothing to do with
 * what they are about.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";

type LegReaction =
	/** Answers and says nothing else — the voicemail box that picked up. */
	| { readonly kind: "answer" }
	/** Answers, then presses one digit per prompt it hears. `undefined` sits the prompt out. */
	| { readonly kind: "presses"; readonly digits: readonly (string | undefined)[] }
	| { readonly kind: "reject"; readonly cause: HangupCause }
	/** Answers, then hangs up as the question begins. */
	| { readonly kind: "abandons" }
	/** Rings forever: the walker's own timeout is what has to end it. */
	| { readonly kind: "silent" };

interface HarnessOptions {
	/** How each originated endpoint behaves. Keyed by a substring of the endpoint. */
	readonly reactions?: Record<string, LegReaction>;
	readonly settings?: Partial<PlanWalkerSettings>;
	/** Makes the media plane refuse playback, as `mediad` does below its file-playback rung. */
	readonly playRefused?: boolean;
	/** Runs when a leg is asked to confirm — the caller's own hangup is staged from here. */
	readonly onPrompt?: (mediaChannelId: string, round: number) => void;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const originatedLegs: OriginatedLeg[] = [];
	const hangingUp: { mediaChannelId: string; cause: HangupCause }[] = [];
	const bridged: { mediaChannelId: string; bridgeId: string }[] = [];
	const prompted: string[] = [];
	const state = { answered: false, tearingDown: false, detached: false };
	/** Which endpoint each originated channel id belongs to, so `play` knows who it is asking. */
	const endpointOf = new Map<string, string>();
	const rounds = new Map<string, number>();

	const reactionFor = (endpoint: string): LegReaction => {
		for (const [fragment, reaction] of Object.entries(options.reactions ?? {})) {
			if (endpoint.includes(fragment)) {
				return reaction;
			}
		}
		return { kind: "reject", cause: "NO_ANSWER" };
	};

	const fake = makeFakeMediaPort({
		onOriginate: (request) => {
			endpointOf.set(request.channelId, request.endpoint);
			const reaction = reactionFor(request.endpoint);
			if (reaction.kind === "silent") {
				return;
			}
			if (reaction.kind === "reject") {
				signals.emit(legSignalKey(request.channelId), {
					kind: "ended",
					cause: reaction.cause,
					causeCode: 16,
				});
				return;
			}
			signals.emit(legSignalKey(request.channelId), { kind: "answered" });
		},
	});

	/**
	 * The fake, with the far end's reaction to the question wired into `play`.
	 *
	 * A spread rather than a subclass because `FakeMediaPort` is an object: `calls` stays the same
	 * array, so every existing assertion helper on it still reads the whole timeline.
	 */
	const media: typeof fake = {
		...fake,
		play: async (channelId: string, request: PlayRequest) => {
			prompted.push(channelId);
			if (options.playRefused === true) {
				throw new MediaOperationNotSupportedError("play", "file playback (rung 1)");
			}
			const handle = await fake.play(channelId, request);
			const round = rounds.get(channelId) ?? 0;
			rounds.set(channelId, round + 1);
			options.onPrompt?.(channelId, round);

			const reaction = reactionFor(endpointOf.get(channelId) ?? "");
			// A timer, not a microtask: see the file header.
			const timer = setTimeout(() => {
				if (reaction.kind === "abandons") {
					signals.emit(legSignalKey(channelId), {
						kind: "ended",
						cause: "NORMAL_CLEARING",
						causeCode: 16,
					});
					return;
				}
				const digit = reaction.kind === "presses" ? reaction.digits[round] : undefined;
				if (digit !== undefined) {
					signals.emit(legSignalKey(channelId), { kind: "dtmf", digit });
				}
			}, 0);
			timer.unref?.();
			return handle;
		},
	};

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

	/** The caller goes away, exactly as the orchestrator reports it. */
	const callerHangsUp = (): void => {
		state.tearingDown = true;
		signals.emit(legSignalKey(A_CHANNEL), {
			kind: "ended",
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});
	};

	let counter = 0;
	const walker = new PlanWalker({
		media: media as MediaPort,
		signals,
		channel,
		execute,
		publish: async () => undefined,
		settings: {
			answerTimeoutMs: 200,
			confirmAttempts: 2,
			// Short: every "nobody pressed anything" spec pays this twice.
			confirmTimeoutMs: 25,
			...options.settings,
		},
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
		delay: async () => undefined,
	});

	return {
		walker,
		media: fake,
		verbs,
		originatedLegs,
		hangingUp,
		bridged,
		prompted,
		callerHangsUp,
		endpointOf,
	};
}

function walkInput(nodes: readonly PlanNode[]): WalkInput {
	return { plan: planOf(nodes) };
}

function hop(overrides: Partial<FollowMeDestination> = {}): FollowMeDestination {
	return {
		ordinal: 0,
		destination: "1002",
		delaySeconds: 0,
		timeoutSeconds: 1,
		confirmRequired: false,
		targetNodeId: "desk",
		...overrides,
	};
}

function mobileHop(overrides: Partial<FollowMeDestination> = {}): FollowMeDestination {
	return hop({
		ordinal: 1,
		destination: "+15559998888",
		targetNodeId: "route",
		dialedNumber: "+15559998888",
		confirmRequired: true,
		...overrides,
	});
}

function ladder(
	destinations: readonly FollowMeDestination[],
	overrides: Partial<FollowMePlan> = {},
): FollowMePlan {
	return { strategy: "sequential", ignoreBusy: false, destinations, ...overrides };
}

const DESK = extensionNode("desk", { number: "1002" });
const ROUTE = trunkDialNode("route");
const MOBILE = "PJSIP/+15559998888@carrier-a";

/** A ladder whose only hop is the mobile, so nothing else can decide the outcome. */
function mobileLadder(overrides: Partial<FollowMePlan> = {}): readonly PlanNode[] {
	return [
		extensionNode("ext", {
			number: "1001",
			followMe: ladder([mobileHop({ ordinal: 0 })], overrides),
			noAnswerNodeId: "vm",
		}),
		DESK,
		ROUTE,
		hangupNode("vm", "NO_ANSWER"),
	];
}

// =================================================================================================
// Sequential
// =================================================================================================

describe("a follow-me hop that has to confirm", () => {
	it("bridges the call when the accept digit arrives", async () => {
		const h = harness({ reactions: { [MOBILE]: { kind: "presses", digits: ["1"] } } });
		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		expect(outcome.status).toBe("bridged");
		expect(h.prompted).toHaveLength(1);
		expect(h.bridged).toHaveLength(1);
		// The question stops the moment it is answered rather than playing over the caller.
		expect(h.media.methods()).toContain("stopPlayback");
	});

	it("carries on down the ladder when nobody presses anything", async () => {
		const h = harness({
			reactions: {
				[MOBILE]: { kind: "answer" },
				"PJSIP/1002": { kind: "presses", digits: ["1"] },
			},
		});
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					// The mobile FIRST, so the desk phone can only be reached by the mobile failing.
					followMe: ladder([mobileHop({ ordinal: 0 }), hop({ ordinal: 1, confirmRequired: true })]),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.originatedLegs.map((leg) => leg.endpoint)).toEqual([MOBILE, "PJSIP/1002"]);
		// Asked twice — the configured budget — before it was given up on.
		expect(h.prompted.filter((id) => id === h.originatedLegs[0]?.mediaChannelId)).toHaveLength(2);
		expect(h.bridged.map((leg) => leg.mediaChannelId)).toEqual([
			h.originatedLegs[1]?.mediaChannelId as string,
		]);
	});

	it("lands in the extension's own mailbox when the only hop never confirms", async () => {
		const h = harness({ reactions: { [MOBILE]: { kind: "answer" } } });
		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		expect(outcome.status).toBe("hangup");
		expect(outcome.visited).toEqual(["ext", "vm"]);
		expect(outcome.notes.join(" ")).toContain("did not confirm the call");
		expect(h.hangingUp).toEqual([
			{ mediaChannelId: h.originatedLegs[0]?.mediaChannelId as string, cause: "ORIGINATOR_CANCEL" },
		]);
	});

	it("re-asks after a wrong digit, and accepts the right one", async () => {
		const h = harness({ reactions: { [MOBILE]: { kind: "presses", digits: ["7", "1"] } } });
		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		expect(h.prompted).toHaveLength(2);
		expect(outcome.status).toBe("bridged");
	});

	it("gives up when every attempt gets the wrong digit", async () => {
		const h = harness({ reactions: { [MOBILE]: { kind: "presses", digits: ["7", "9", "1"] } } });
		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		// Two attempts, and the third digit is never asked for.
		expect(h.prompted).toHaveLength(2);
		expect(outcome.status).toBe("hangup");
		expect(h.bridged).toHaveLength(0);
	});

	it("stops the moment the leg being asked hangs up, rather than waiting out its budget", async () => {
		const h = harness({
			reactions: { [MOBILE]: { kind: "abandons" } },
			// Long enough that a spec which waited for it would not finish.
			settings: { confirmTimeoutMs: 30_000 },
		});
		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		expect(outcome.status).toBe("hangup");
		expect(outcome.notes.join(" ")).toContain("hung up before it confirmed");
	});

	it("abandons the whole walk when the CALLER hangs up mid-question", async () => {
		let hangUp = (): void => undefined;
		const h = harness({
			reactions: { [MOBILE]: { kind: "answer" } },
			settings: { confirmTimeoutMs: 30_000 },
			onPrompt: () => {
				setTimeout(() => {
					hangUp();
				}, 0);
			},
		});
		hangUp = h.callerHangsUp;

		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		expect(outcome.status).toBe("aborted");
		expect(h.bridged).toHaveLength(0);
		// The callee is not left connected to a caller who has gone.
		expect(h.hangingUp.map((leg) => leg.cause)).toEqual(["ORIGINATOR_CANCEL"]);
		expect(outcome.notes.join(" ")).toContain("the caller hung up");
	});

	it("never bridges when the media plane cannot play the question", async () => {
		const h = harness({
			reactions: { [MOBILE]: { kind: "presses", digits: ["1"] } },
			playRefused: true,
		});
		const outcome = await h.walker.walk(walkInput(mobileLadder()));

		expect(outcome.status).toBe("hangup");
		expect(h.bridged).toHaveLength(0);
		// Asked once, refused once: a refusal is not retried, it is a property of the deployment.
		expect(h.prompted).toHaveLength(1);
		expect(outcome.notes.join(" ")).toContain("cannot play audio");
	});

	it("leaves a hop that does NOT confirm exactly as it was", async () => {
		const h = harness({ reactions: { "PJSIP/1002": { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([extensionNode("ext", { number: "1001", followMe: ladder([hop()]) }), DESK, ROUTE]),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.prompted).toEqual([]);
	});
});

// =================================================================================================
// Simultaneous
// =================================================================================================

describe("a simultaneous ladder in which two hops answer", () => {
	it("gives the call to the one that confirms, and tears the other down", async () => {
		const h = harness({
			reactions: {
				// The mobile's voicemail answers first and says nothing; the desk phone accepts.
				[MOBILE]: { kind: "answer" },
				"PJSIP/1002": { kind: "presses", digits: ["1"] },
			},
		});
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder(
						[mobileHop({ ordinal: 0 }), hop({ ordinal: 1, confirmRequired: true })],
						{ strategy: "simultaneous" },
					),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		const mobileLeg = h.originatedLegs[0]?.mediaChannelId as string;
		const deskLeg = h.originatedLegs[1]?.mediaChannelId as string;

		expect(outcome.status).toBe("bridged");
		expect(h.bridged.map((leg) => leg.mediaChannelId)).toEqual([deskLeg]);
		// Exactly one bridge: an answered-but-unconfirmed leg never reaches one.
		expect(h.media.methods().filter((method) => method === "createBridge")).toHaveLength(1);
		expect(h.hangingUp.map((leg) => leg.mediaChannelId)).toContain(mobileLeg);
	});

	it("gives it to whichever confirms FIRST when both do", async () => {
		const h = harness({
			reactions: {
				[MOBILE]: { kind: "presses", digits: ["1"] },
				// Two prompts' worth of silence before this one accepts, so the order is decided.
				"PJSIP/1002": { kind: "presses", digits: [undefined, "1"] },
			},
			settings: { confirmTimeoutMs: 40 },
		});
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder(
						[mobileHop({ ordinal: 0 }), hop({ ordinal: 1, confirmRequired: true })],
						{ strategy: "simultaneous" },
					),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.bridged.map((leg) => leg.mediaChannelId)).toEqual([
			h.originatedLegs[0]?.mediaChannelId as string,
		]);
		expect(h.media.methods().filter((method) => method === "createBridge")).toHaveLength(1);
		expect(h.hangingUp.map((leg) => leg.cause)).toContain("LOSE_RACE");
	});

	it("takes the no-answer branch when every hop answered and none confirmed", async () => {
		const h = harness({
			reactions: {
				[MOBILE]: { kind: "answer" },
				"PJSIP/1002": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					followMe: ladder(
						[mobileHop({ ordinal: 0 }), hop({ ordinal: 1, confirmRequired: true })],
						{ strategy: "simultaneous" },
					),
					noAnswerNodeId: "vm",
				}),
				DESK,
				ROUTE,
				hangupNode("vm", "NO_ANSWER"),
			]),
		);

		expect(outcome.visited).toEqual(["ext", "vm"]);
		expect(h.bridged).toHaveLength(0);
		expect(h.hangingUp.every((leg) => leg.cause === "ORIGINATOR_CANCEL")).toBe(true);
	});
});
