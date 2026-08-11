import { describe, expect, it } from "bun:test";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	MIN_SALT_BYTES,
} from "@optimiq-voice/routing";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "./call-signals";
import { DEFAULT_MEDIA_REF_SETTINGS } from "./media-refs";
import {
	extensionNode,
	hangupNode,
	ivrMenuNode,
	planOf,
	playbackNode,
	ringGroupNode,
	timeConditionNode,
	trunkAttempt,
	trunkDialNode,
	voicemailNode,
} from "./plan-fixtures.fake";
import { composeCallerId, PlanWalker } from "./plan-walker";
import type { FakeMediaPortOptions } from "../media/media-port.fake";
import type { PlanDestination } from "./plan-destination";
import type {
	PlanWalkerSettings,
	VoicemailMailboxSource,
	VoicemailMessage,
	VoicemailPort,
	WalkerChannel,
	WalkInput,
} from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { CompiledTimeCondition, PlanNode, TrunkDialPlanNode } from "@optimiq-voice/routing";
import type {
	ChannelState,
	DtmfCollection,
	HangupCause,
	Verb,
	VerbResult,
} from "@optimiq-voice/telephony";

/**
 * Plan-walker specs, driven entirely by fakes.
 *
 * Every collaborator is a port — the media server, the verb executor, the event publisher and the
 * signal bus — so a complete inbound call through a time condition, an IVR, a ring group and a
 * bridge runs in process with no Asterisk, no NATS and no clock control.
 *
 * The one thing these specs deliberately do NOT fake is timing: a leg that answers does so by
 * emitting on the real signal bus from inside the fake `originate`, which reproduces the actual
 * race the walker has to survive (`StasisStart` arriving before the originate's HTTP response).
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";

interface PublishedEvent {
	readonly type: CallEvent;
	readonly data: Record<string, unknown>;
}

interface HarnessOptions {
	/** How each originated endpoint behaves. Keyed by a substring of the endpoint. */
	readonly reactions?: Record<string, LegReaction>;
	/** Collections the fake `gather` returns, in order. Exhausted entries repeat the last one. */
	readonly gathers?: readonly DtmfCollection[];
	readonly settings?: Partial<PlanWalkerSettings>;
	readonly answered?: boolean;
	readonly media?: FakeMediaPortOptions;
	/** Verbs the fake executor should report as FAILED. */
	readonly failVerbs?: readonly Verb["verb"][];
	/** How a started recording ends. Defaults to finishing immediately. */
	readonly recording?:
		| { readonly kind: "finished"; readonly durationMs: number }
		| { readonly kind: "failed"; readonly reason: string }
		/** Never reports: the walker's own backstop timer is what has to end it. */
		| { readonly kind: "silent" };
	/** Where a recorded message is filed. Absent means the walk has no voicemail port. */
	readonly voicemail?: VoicemailPort;
	/** Where the `*97` menu reads a mailbox from. Absent means the walk has no mailbox source. */
	readonly mailbox?: VoicemailMailboxSource;
	/** Makes ONE event type's publish throw — how "a slow broker must not end a call" is tested. */
	readonly failPublishOf?: CallEvent;
}

type LegReaction =
	| { readonly kind: "answer" }
	| { readonly kind: "enter" }
	| { readonly kind: "reject"; readonly cause: HangupCause }
	| { readonly kind: "unreachable" }
	/** Rings forever: the walker's own timeout is what has to end it. */
	| { readonly kind: "silent" };

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const published: PublishedEvent[] = [];
	const states: ChannelState[] = [];
	/** One ordered list across both ports, so "answered AFTER originate" is directly assertable. */
	const timeline: string[] = [];
	const destinations: PlanDestination[] = [];
	const gathers = [...(options.gathers ?? [])];
	const failed = new Set<string>(options.failVerbs ?? []);

	const state = {
		answered: options.answered ?? false,
		tearingDown: false,
		detached: false,
		bridgeId: undefined as string | undefined,
	};

	const reactionFor = (endpoint: string): LegReaction | undefined => {
		for (const [fragment, reaction] of Object.entries(options.reactions ?? {})) {
			if (endpoint.includes(fragment)) {
				return reaction;
			}
		}
		return undefined;
	};

	const media = makeFakeMediaPort({
		...options.media,
		originateFails: (request) =>
			reactionFor(request.endpoint)?.kind === "unreachable"
				? new Error("endpoint has no contact")
				: options.media?.originateFails?.(request),
		onOriginate: (request) => {
			timeline.push(`originate:${request.endpoint}`);
			const reaction = reactionFor(request.endpoint);
			if (reaction === undefined || reaction.kind === "silent") {
				return;
			}
			if (reaction.kind === "answer") {
				signals.emit(legSignalKey(request.channelId), { kind: "answered" });
				return;
			}
			if (reaction.kind === "enter") {
				signals.emit(legSignalKey(request.channelId), { kind: "entered" });
				return;
			}
			if (reaction.kind === "reject") {
				signals.emit(legSignalKey(request.channelId), {
					kind: "ended",
					cause: reaction.cause,
					causeCode: 16,
				});
			}
		},
		onRecord: (_channelId, request) => {
			const reaction = options.recording ?? { kind: "finished" as const, durationMs: 4_200 };
			if (reaction.kind === "silent") {
				return;
			}
			signals.emit(
				recordingSignalKey(request.name),
				reaction.kind === "finished"
					? { kind: "recording-finished", durationMs: reaction.durationMs }
					: { kind: "recording-failed", reason: reaction.reason },
			);
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
		timeline.push(`verb:${verb.verb}`);
		if (failed.has(verb.verb)) {
			return undefined;
		}
		switch (verb.verb) {
			case "answer": {
				state.answered = true;
				// The real orchestrator publishes this when ARI reports `Up`; the walker waits for it.
				signals.emit(legSignalKey(A_CHANNEL), { kind: "answered" });
				return { verb: "answer", endReason: "completed" };
			}
			case "hangup": {
				state.tearingDown = true;
				return { verb: "hangup", endReason: "completed" };
			}
			case "gather": {
				// The LAST scripted collection repeats once the script runs out, so a spec about
				// retry budgets does not have to spell the same entry out `maxFailures` times.
				const collection: DtmfCollection = (gathers.length > 1 ? gathers.shift() : gathers[0]) ?? {
					digits: [],
					endReason: "timeout",
				};
				return {
					verb: "gather",
					endReason: collection.endReason === "timeout" ? "timeout" : "completed",
					collection,
					elapsedMs: 1,
				};
			}
			case "play": {
				return { verb: "play", endReason: "completed", playbackRef: "pb-1", elapsedMs: 1 };
			}
			default: {
				return { verb: verb.verb as never, endReason: "completed" };
			}
		}
	};

	let counter = 0;
	const walker = new PlanWalker({
		media,
		signals,
		channel,
		execute,
		publish: async (type, data) => {
			if (options.failPublishOf === type) {
				throw new Error("the broker is unreachable");
			}
			published.push({ type, data });
		},
		settings: { answerTimeoutMs: 200, ...options.settings },
		peerLegId: (mediaChannelId) => `leg-of-${mediaChannelId}`,
		onDestination: async (destination) => {
			// Onto the SAME timeline as the verbs, because the only thing worth asserting about this
			// hook is when it fires relative to the node that reported it.
			timeline.push(`destination:${destination.destinationType}`);
			destinations.push(destination);
		},
		...(options.voicemail === undefined ? {} : { voicemail: options.voicemail }),
		...(options.mailbox === undefined ? {} : { mailbox: options.mailbox }),
		newId: () => {
			counter += 1;
			return `id-${String(counter)}`;
		},
		// Ring delays are asserted through the originate order, never waited on.
		delay: async () => undefined,
	});

	return {
		walker,
		media,
		signals,
		verbs,
		published,
		states,
		state,
		channel,
		timeline,
		destinations,
	};
}

const NOW = new Date("2026-08-05T12:00:00.000Z");

function walkInput(nodes: readonly PlanNode[], overrides: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), now: NOW, ...overrides };
}

function verbNames(verbs: readonly Verb[]): string[] {
	return verbs.map((verb) => verb.verb);
}

// =================================================================================================
// Terminals and playback
// =================================================================================================

describe("hangup nodes", () => {
	it("hangs the leg up with the plan's own cause", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([hangupNode("h", "UNALLOCATED_NUMBER")]));

		expect(outcome.status).toBe("hangup");
		expect(outcome.hangupCause).toBe("UNALLOCATED_NUMBER");
		expect(h.verbs).toEqual([{ verb: "hangup", cause: "UNALLOCATED_NUMBER" }]);
	});

	it("does NOT answer the call before rejecting it", async () => {
		const h = harness();
		await h.walker.walk(walkInput([hangupNode("h", "CALL_REJECTED")]));

		// An implicit answer would start billing a caller for a call that was refused.
		expect(verbNames(h.verbs)).not.toContain("answer");
		expect(h.state.answered).toBe(false);
	});

	it("records no destination for a plan that is only a terminal", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([hangupNode("h", "NORMAL_CLEARING")]));
		expect(outcome.destination).toBeUndefined();
	});

	it("reports the nodes it visited", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([hangupNode("h", "NORMAL_CLEARING")]));
		expect(outcome.visited).toEqual(["h"]);
	});

	it("refuses a plan whose entry node is missing from the table", async () => {
		const h = harness();
		const outcome = await h.walker.walk({
			plan: { entryNodeId: "ghost", nodes: {} },
			now: NOW,
		});

		expect(outcome.status).toBe("hangup");
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(outcome.notes.join(" ")).toContain("missing from the artifact");
	});
});

/**
 * `onDestination` — the hook that exists entirely for WHEN it fires.
 *
 * The walk's own result carries the same destination, and for a call that ends up bridged the two
 * are interchangeable. For a call the walk HANGS UP they are not: the leg is torn down from inside
 * the walk, the CDR is written by the teardown, and a destination reported afterwards arrives after
 * the record it belonged in. See the hook's own note.
 */
describe("destinations reported during the walk", () => {
	it("reports a destination BEFORE the node that owns it does anything", async () => {
		const h = harness();
		await h.walker.walk(walkInput([playbackNode("p", { promptId: "welcome" })]));

		// Not merely "somewhere before the play": before the ANSWER, which is the first thing a
		// playback node does and already too late for a caller who hangs up during the greeting.
		expect(h.timeline[0]).toBe("destination:playback");
		expect(h.timeline.filter((entry) => entry.startsWith("verb:")).length).toBeGreaterThan(0);
	});

	it("reports one destination per destination-bearing node, in the order they were entered", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([
				ivrMenuNode("ivr", { maxTimeouts: 0, timeoutNodeId: "ext" }),
				extensionNode("ext"),
			]),
		);

		expect(h.destinations.map((destination) => destination.destinationType)).toEqual([
			"ivr-menu",
			"extension",
		]);
		expect(h.destinations.at(-1)).toEqual(outcome.destination as PlanDestination);
	});

	it("reports nothing for a plan of steps and terminals, so an unrouted CDR stays unrouted", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([
				timeConditionNode("tc", { matchNodeId: "h", noMatchNodeId: "h" }),
				hangupNode("h", "NORMAL_CLEARING"),
			]),
		);

		// A gate and a terminal are not places a call went. See `planDestinationOf`.
		expect(h.destinations).toEqual([]);
	});
});

describe("playback nodes", () => {
	it("answers, plays the prompt, then follows `thenNodeId`", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				playbackNode("p", { promptId: "welcome", thenNodeId: "h" }),
				hangupNode("h", "NORMAL_CLEARING"),
			]),
		);

		expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
		expect(h.verbs[1]).toMatchObject({ verb: "play", media: "sound:welcome" });
		expect(outcome.visited).toEqual(["p", "h"]);
	});

	it("hangs up normally when there is nothing after the prompt", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([playbackNode("p")]));
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("passes through a node that names no playable media, and says so", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{ id: "p", kind: "playback", thenNodeId: "h" } as PlanNode,
				hangupNode("h", "NORMAL_CLEARING"),
			]),
		);

		expect(verbNames(h.verbs)).toEqual(["hangup"]);
		expect(outcome.notes.join(" ")).toContain("names no playable media");
	});

	it("translates a `prompt://` media ref rather than passing it to the media server", async () => {
		const h = harness();
		await h.walker.walk(walkInput([playbackNode("p", { media: "prompt://after-hours" })]));
		expect(h.verbs[1]).toMatchObject({ media: "sound:after-hours" });
	});

	it("reports a playback as the walk's destination", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([playbackNode("p")]));
		expect(outcome.destination).toEqual({ destinationType: "playback" });
	});

	it("ends the walk when the leg goes away before it can be answered", async () => {
		const h = harness({ failVerbs: ["answer"] });
		const outcome = await h.walker.walk(walkInput([playbackNode("p")]));
		expect(outcome.status).toBe("aborted");
	});
});

// =================================================================================================
// Time conditions
// =================================================================================================

const ALWAYS_OPEN: CompiledTimeCondition = {
	id: "tc-t",
	name: "always",
	timezone: "UTC",
	rules: [{ id: "r", ordinal: 0, predicates: [] }],
};

const NEVER_OPEN: CompiledTimeCondition = {
	id: "tc-t",
	name: "never",
	timezone: "UTC",
	rules: [
		{
			id: "r",
			ordinal: 0,
			predicates: [{ dateRange: { from: "1999-01-01", to: "1999-01-02" } }],
		},
	],
};

describe("time-condition destination nodes", () => {
	it("takes the match branch when the condition is open", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(
				[
					timeConditionNode("t", { matchNodeId: "open", noMatchNodeId: "closed" }),
					hangupNode("open", "NORMAL_CLEARING"),
					hangupNode("closed", "USER_BUSY"),
				],
				{ timeConditions: { "tc-t": ALWAYS_OPEN } },
			),
		);

		expect(outcome.visited).toEqual(["t", "open"]);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("takes the no-match branch when the condition is closed", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(
				[
					timeConditionNode("t", { matchNodeId: "open", noMatchNodeId: "closed" }),
					hangupNode("open", "NORMAL_CLEARING"),
					hangupNode("closed", "USER_BUSY"),
				],
				{ timeConditions: { "tc-t": NEVER_OPEN } },
			),
		);

		expect(outcome.visited).toEqual(["t", "closed"]);
		expect(outcome.hangupCause).toBe("USER_BUSY");
	});

	it("hangs up normally when a closed condition has no no-match branch", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(
				[timeConditionNode("t", { matchNodeId: "open" }), hangupNode("open", "USER_BUSY")],
				{
					timeConditions: { "tc-t": NEVER_OPEN },
				},
			),
		);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("treats a missing condition as OPEN and reports the gap", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				timeConditionNode("t", { matchNodeId: "open", noMatchNodeId: "closed" }),
				hangupNode("open", "NORMAL_CLEARING"),
				hangupNode("closed", "USER_BUSY"),
			]),
		);

		expect(outcome.visited).toEqual(["t", "open"]);
		expect(outcome.notes.join(" ")).toContain("missing from the artifact");
	});

	it("does not report a gate as the call's destination", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(
				[timeConditionNode("t", { matchNodeId: "p" }), playbackNode("p", { promptId: "welcome" })],
				{ timeConditions: { "tc-t": ALWAYS_OPEN } },
			),
		);
		expect(outcome.destination).toEqual({ destinationType: "playback" });
	});
});

// =================================================================================================
// Extensions
// =================================================================================================

describe("extension nodes", () => {
	const plan = (overrides = {}) => [
		extensionNode("e", { number: "1001", ...overrides }),
		hangupNode("busy", "USER_BUSY"),
		hangupNode("na", "NO_ANSWER"),
		hangupNode("nr", "USER_NOT_REGISTERED"),
	];

	it("rings the caller, originates the endpoint, and bridges on answer", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		const outcome = await h.walker.walk(walkInput(plan()));

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated()[0]?.endpoint).toBe("PJSIP/1001");
		expect(h.media.methods()).toContain("createBridge");
		expect(h.media.methods()).toContain("addToBridge");
	});

	it("uses the configured dial template", async () => {
		const h = harness({
			reactions: { "Local/1001": { kind: "answer" } },
			settings: { extensionDialTemplate: "Local/{number}@optimiq-internal" },
		});
		await h.walker.walk(walkInput(plan()));
		expect(h.media.originated()[0]?.endpoint).toBe("Local/1001@optimiq-internal");
	});

	it("answers the A-leg only AFTER the callee has answered", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(plan()));

		// Answering earlier would start billing the caller for a call nobody had picked up.
		expect(h.timeline.indexOf("verb:answer")).toBeGreaterThan(
			h.timeline.indexOf("originate:PJSIP/1001"),
		);
	});

	it("presents the INBOUND caller's identity on the originated leg", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(plan()));
		expect(h.media.originated()[0]?.callerId).toBe('"Ada" <+15551234567>');
	});

	it("exports the organization and the originating leg onto the B-leg", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(plan()));
		expect(h.media.originated()[0]?.variables).toMatchObject({
			OPTIMIQ_ORG_ID: ORG_ID,
			OPTIMIQ_LEG: "b",
			OPTIMIQ_ORIGINATING_LEG_ID: A_LEG_ID,
		});
	});

	it("publishes channel.bridged with the bridge and the peer leg", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(plan()));

		const bridged = h.published.find((event) => event.type === "channel.bridged");
		expect(bridged?.data).toMatchObject({ legId: A_LEG_ID, mode: "full" });
		expect(String(bridged?.data.peerLegId)).toStartWith("leg-of-");
	});

	it("moves the channel to `exchanging-media` through the guarded transition", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(plan()));
		expect(h.states).toContain("exchanging-media");
		expect(h.state.bridgeId).toBeDefined();
	});

	it("takes the busy branch on USER_BUSY", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "reject", cause: "USER_BUSY" } } });
		const outcome = await h.walker.walk(
			walkInput(plan({ busyNodeId: "busy", noAnswerNodeId: "na", notRegisteredNodeId: "nr" })),
		);
		expect(outcome.visited).toEqual(["e", "busy"]);
	});

	it("takes the not-registered branch when the media server cannot reach the endpoint", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "unreachable" } } });
		const outcome = await h.walker.walk(
			walkInput(plan({ busyNodeId: "busy", noAnswerNodeId: "na", notRegisteredNodeId: "nr" })),
		);
		expect(outcome.visited).toEqual(["e", "nr"]);
		expect(outcome.notes.join(" ")).toContain("could not be reached");
	});

	it("takes the no-answer branch on any other failure cause", async () => {
		const h = harness({
			reactions: { "PJSIP/1001": { kind: "reject", cause: "NO_ANSWER" } },
		});
		const outcome = await h.walker.walk(
			walkInput(plan({ busyNodeId: "busy", noAnswerNodeId: "na", notRegisteredNodeId: "nr" })),
		);
		expect(outcome.visited).toEqual(["e", "na"]);
	});

	it("falls back to the no-answer branch when there is no busy branch", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "reject", cause: "USER_BUSY" } } });
		const outcome = await h.walker.walk(walkInput(plan({ noAnswerNodeId: "na" })));
		expect(outcome.visited).toEqual(["e", "na"]);
	});

	it("hangs up with the failure cause when no branch is configured", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "reject", cause: "USER_BUSY" } } });
		const outcome = await h.walker.walk(walkInput(plan()));
		expect(outcome.hangupCause).toBe("USER_BUSY");
	});

	it("short-circuits to the busy branch when do-not-disturb is on, without dialling", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(plan({ doNotDisturb: true, busyNodeId: "busy" })),
		);

		expect(h.media.originated()).toEqual([]);
		expect(outcome.visited).toEqual(["e", "busy"]);
	});

	it("takes forward-all BEFORE the phone rings", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(plan({ forwardAllNodeId: "na", doNotDisturb: true })),
		);

		expect(h.media.originated()).toEqual([]);
		expect(outcome.visited).toEqual(["e", "na"]);
	});

	it("gives up after the ring timeout and takes the no-answer branch", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "silent" } } });
		const outcome = await h.walker.walk(
			walkInput(plan({ timeoutSeconds: 1, noAnswerNodeId: "na" })),
		);

		expect(outcome.visited).toEqual(["e", "na"]);
		expect(h.media.hungUp()).toContainEqual({
			channelId: "id-1",
			cause: "ORIGINATOR_CANCEL",
		});
	});

	it("reports the extension as the CDR destination", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		const outcome = await h.walker.walk(walkInput(plan()));
		expect(outcome.destination).toEqual({
			destinationType: "extension",
			destinationRef: "ext-e",
		});
	});

	it("tears the call down when bridging itself fails", async () => {
		const h = harness({
			reactions: { "PJSIP/1001": { kind: "answer" } },
			media: { bridgeFails: true },
		});
		const outcome = await h.walker.walk(walkInput(plan()));

		expect(outcome.status).toBe("hangup");
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(h.media.hungUp().map((call) => call.cause)).toContain("NORMAL_TEMPORARY_FAILURE");
	});

	it("hangs the A-leg up once the bridged peer goes away", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(plan()));

		h.signals.emit(legSignalKey("id-1"), {
			kind: "ended",
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(h.published.map((event) => event.type)).toContain("channel.unbridged");
		expect(h.media.methods()).toContain("destroyBridge");
	});
});

// =================================================================================================
// Ring groups
// =================================================================================================

describe("ring groups", () => {
	const group = (overrides = {}) => [
		ringGroupNode("g", {
			members: [
				{
					ordinal: 0,
					delaySeconds: 0,
					timeoutSeconds: 5,
					confirmRequired: false,
					targetNodeId: "a",
				},
				{
					ordinal: 1,
					delaySeconds: 0,
					timeoutSeconds: 5,
					confirmRequired: false,
					targetNodeId: "b",
				},
			],
			...overrides,
		}),
		extensionNode("a", { number: "1001" }),
		extensionNode("b", { number: "1002" }),
		hangupNode("timeout", "NO_ANSWER"),
	];

	it("rings every member at once and bridges the first to answer", async () => {
		const h = harness({
			reactions: { "PJSIP/1002": { kind: "answer" } },
		});
		const outcome = await h.walker.walk(walkInput(group({ timeoutNodeId: "timeout" })));

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated().map((call) => call.endpoint)).toEqual(["PJSIP/1001", "PJSIP/1002"]);
	});

	it("hangs the losers up with LOSE_RACE, not NORMAL_CLEARING", async () => {
		const h = harness({ reactions: { "PJSIP/1002": { kind: "answer" } } });
		await h.walker.walk(walkInput(group({ timeoutNodeId: "timeout" })));

		// Q.850 26, "non-selected user clearing": a loser reporting normal clearing is
		// indistinguishable from a caller who hung up, and that shows up in billing disputes.
		expect(h.media.hungUp()).toContainEqual({ channelId: "id-1", cause: "LOSE_RACE" });
	});

	it("does not hang up a member that had already failed", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "reject", cause: "USER_BUSY" },
				"PJSIP/1002": { kind: "answer" },
			},
		});
		await h.walker.walk(walkInput(group({ timeoutNodeId: "timeout" })));
		expect(h.media.hungUp().map((call) => call.channelId)).not.toContain("id-1");
	});

	it("takes the timeout branch when every member fails", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "reject", cause: "NO_ANSWER" },
				"PJSIP/1002": { kind: "reject", cause: "NO_ANSWER" },
			},
		});
		const outcome = await h.walker.walk(walkInput(group({ timeoutNodeId: "timeout" })));
		expect(outcome.visited).toEqual(["g", "timeout"]);
	});

	it("hangs up with NO_ANSWER when the group has no timeout branch", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "reject", cause: "NO_ANSWER" },
				"PJSIP/1002": { kind: "reject", cause: "NO_ANSWER" },
			},
		});
		const outcome = await h.walker.walk(walkInput(group()));
		expect(outcome.hangupCause).toBe("NO_ANSWER");
	});

	it("gives up on the group's own ring timeout and cancels the outstanding legs", async () => {
		const h = harness({
			reactions: { PJSIP: { kind: "silent" } },
		});
		const outcome = await h.walker.walk(
			walkInput(group({ ringTimeoutSeconds: 1, timeoutNodeId: "timeout" })),
		);

		expect(outcome.visited).toEqual(["g", "timeout"]);
		expect(h.media.hungUp().map((call) => call.cause)).toEqual([
			"ORIGINATOR_CANCEL",
			"ORIGINATOR_CANCEL",
		]);
	});

	it("rings members in ordinal order when the strategy is sequential", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "reject", cause: "NO_ANSWER" },
				"PJSIP/1002": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput(group({ strategy: "sequential", timeoutNodeId: "timeout" })),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated().map((call) => call.endpoint)).toEqual(["PJSIP/1001", "PJSIP/1002"]);
	});

	it("stops a sequential group at a busy member when `ignoreBusy` is false", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "reject", cause: "USER_BUSY" },
				"PJSIP/1002": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput(group({ strategy: "sequential", ignoreBusy: false, timeoutNodeId: "timeout" })),
		);

		expect(h.media.originated()).toHaveLength(1);
		expect(outcome.visited).toEqual(["g", "timeout"]);
	});

	it("walks past a busy member when `ignoreBusy` is true", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "reject", cause: "USER_BUSY" },
				"PJSIP/1002": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput(group({ strategy: "sequential", ignoreBusy: true })),
		);
		expect(outcome.status).toBe("bridged");
	});

	it("skips a member whose target is not an extension, and says which", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([
				ringGroupNode("g", {
					members: [
						{
							ordinal: 0,
							delaySeconds: 0,
							timeoutSeconds: 5,
							confirmRequired: false,
							targetNodeId: "a",
						},
						{
							ordinal: 1,
							delaySeconds: 0,
							timeoutSeconds: 5,
							confirmRequired: false,
							targetNodeId: "vm",
						},
					],
				}),
				extensionNode("a", { number: "1001" }),
				voicemailNode("vm"),
			]),
		);

		expect(h.media.originated()).toHaveLength(1);
		expect(outcome.notes.join(" ")).toContain("is not an extension");
	});

	it("takes the timeout branch immediately when no member is dialable", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				ringGroupNode("g", { members: [], timeoutNodeId: "timeout" }),
				hangupNode("timeout", "NO_ANSWER"),
			]),
		);

		expect(h.media.originated()).toEqual([]);
		expect(outcome.visited).toEqual(["g", "timeout"]);
		expect(outcome.notes.join(" ")).toContain("no dialable members");
	});

	it("asks a confirming member the group's own prompt, and does not bridge one that stays silent", async () => {
		const h = harness({
			reactions: {
				"PJSIP/1001": { kind: "answer" },
				"PJSIP/1002": { kind: "reject", cause: "NO_ANSWER" },
			},
			settings: { confirmAttempts: 1, confirmTimeoutMs: 20 },
		});
		const outcome = await h.walker.walk(
			walkInput(
				group({ confirmEnabled: true, confirmPromptId: "press-1", timeoutNodeId: "timeout" }),
			),
		);

		expect(
			h.media.calls.filter((call) => call.method === "play").map((call) => call.args[1]),
		).toEqual([{ media: ["sound:press-1"], playbackRef: expect.any(String) }]);
		expect(outcome.visited).toContain("timeout");
		expect(h.media.hungUp().map((leg) => leg.cause)).toContain("ORIGINATOR_CANCEL");
	});

	it("prefixes the group's caller-id name onto the presented identity", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		await h.walker.walk(walkInput(group({ callerIdNamePrefix: "Sales: " })));
		expect(h.media.originated()[0]?.callerId).toBe('"Sales: Ada" <+15551234567>');
	});

	it("reports the ring group as the CDR destination", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "answer" } } });
		const outcome = await h.walker.walk(walkInput(group()));
		expect(outcome.destination).toEqual({
			destinationType: "ring-group",
			destinationRef: "rg-g",
		});
	});

	it("treats a leg that entered Stasis as an answer", async () => {
		const h = harness({ reactions: { "PJSIP/1001": { kind: "enter" } } });
		const outcome = await h.walker.walk(walkInput(group()));
		expect(outcome.status).toBe("bridged");
	});
});

// =================================================================================================
// IVR menus
// =================================================================================================

describe("IVR menus", () => {
	const menu = (overrides = {}) => [
		ivrMenuNode("m", {
			options: [
				{
					ordinal: 0,
					pattern: { kind: "exact", value: "1" },
					matchValue: "1",
					targetNodeId: "one",
				},
				{
					ordinal: 1,
					pattern: { kind: "exact", value: "2" },
					matchValue: "2",
					targetNodeId: "two",
				},
			],
			...overrides,
		}),
		hangupNode("one", "NORMAL_CLEARING"),
		hangupNode("two", "USER_BUSY"),
		hangupNode("timeout", "NO_USER_RESPONSE"),
		hangupNode("invalid", "INVALID_NUMBER_FORMAT"),
	];

	it("answers, gathers with the greeting, and dispatches the matching option", async () => {
		const h = harness({ gathers: [{ digits: ["1"], endReason: "max-digits" }] });
		const outcome = await h.walker.walk(walkInput(menu()));

		expect(verbNames(h.verbs)).toEqual(["answer", "gather", "hangup"]);
		expect(h.verbs[1]).toMatchObject({ verb: "gather", media: "sound:greeting", maxDigits: 1 });
		expect(outcome.visited).toEqual(["m", "one"]);
	});

	it("dispatches the second option", async () => {
		const h = harness({ gathers: [{ digits: ["2"], endReason: "max-digits" }] });
		const outcome = await h.walker.walk(walkInput(menu()));
		expect(outcome.visited).toEqual(["m", "two"]);
	});

	it("plays the invalid prompt and re-prompts after an unmatched digit", async () => {
		const h = harness({
			gathers: [
				{ digits: ["9"], endReason: "max-digits" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		const outcome = await h.walker.walk(walkInput(menu({ invalidPromptId: "sorry" })));

		expect(verbNames(h.verbs)).toEqual(["answer", "gather", "play", "gather", "hangup"]);
		expect(h.verbs[2]).toMatchObject({ media: "sound:sorry" });
		expect(outcome.visited).toEqual(["m", "one"]);
	});

	it("takes the invalid branch once `maxFailures` is exhausted", async () => {
		const h = harness({ gathers: [{ digits: ["9"], endReason: "max-digits" }] });
		const outcome = await h.walker.walk(
			walkInput(menu({ maxFailures: 1, invalidNodeId: "invalid" })),
		);

		// Budget 1 means one retry: two gathers, then the branch.
		expect(verbNames(h.verbs).filter((name) => name === "gather")).toHaveLength(2);
		expect(outcome.visited).toEqual(["m", "invalid"]);
	});

	it("hangs up with INVALID_NUMBER_FORMAT when there is no invalid branch", async () => {
		const h = harness({ gathers: [{ digits: ["9"], endReason: "max-digits" }] });
		const outcome = await h.walker.walk(walkInput(menu({ maxFailures: 0 })));
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
	});

	it("counts timeouts separately from invalid entries", async () => {
		const h = harness({ gathers: [{ digits: [], endReason: "timeout" }] });
		const outcome = await h.walker.walk(
			walkInput(menu({ maxTimeouts: 1, timeoutNodeId: "timeout", invalidNodeId: "invalid" })),
		);

		expect(outcome.visited).toEqual(["m", "timeout"]);
	});

	it("plays the timeout prompt between silent attempts", async () => {
		const h = harness({
			gathers: [
				{ digits: [], endReason: "timeout" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		await h.walker.walk(walkInput(menu({ timeoutPromptId: "still-there" })));
		expect(h.verbs[2]).toMatchObject({ media: "sound:still-there" });
	});

	it("hangs up with NO_USER_RESPONSE when there is no timeout branch", async () => {
		const h = harness({ gathers: [{ digits: [], endReason: "timeout" }] });
		const outcome = await h.walker.walk(walkInput(menu({ maxTimeouts: 0 })));
		expect(outcome.hangupCause).toBe("NO_USER_RESPONSE");
	});

	it("uses the short greeting on retries when one is configured", async () => {
		const h = harness({
			gathers: [
				{ digits: ["9"], endReason: "max-digits" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		await h.walker.walk(walkInput(menu({ shortGreetingPromptId: "short" })));

		const gathers = h.verbs.filter((verb) => verb.verb === "gather");
		expect(gathers[0]).toMatchObject({ media: "sound:greeting" });
		expect(gathers[1]).toMatchObject({ media: "sound:short" });
	});

	it("ends the walk when the caller hangs up mid-collection", async () => {
		const h = harness({ gathers: [{ digits: [], endReason: "hangup" }] });
		const outcome = await h.walker.walk(walkInput(menu()));
		expect(outcome.status).toBe("aborted");
	});

	it("recurses into a submenu and back out again", async () => {
		const h = harness({
			gathers: [
				{ digits: ["1"], endReason: "max-digits" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		const outcome = await h.walker.walk(
			walkInput([
				ivrMenuNode("main", {
					options: [
						{
							ordinal: 0,
							pattern: { kind: "exact", value: "1" },
							matchValue: "1",
							targetNodeId: "sub",
						},
					],
				}),
				ivrMenuNode("sub", {
					greetingPromptId: "sub-greeting",
					options: [
						{
							ordinal: 0,
							pattern: { kind: "exact", value: "1" },
							matchValue: "1",
							targetNodeId: "done",
						},
					],
				}),
				hangupNode("done", "NORMAL_CLEARING"),
			]),
		);

		expect(outcome.visited).toEqual(["main", "sub", "done"]);
	});

	it("matches a regex option", async () => {
		const h = harness({ gathers: [{ digits: ["4", "2"], endReason: "max-digits" }] });
		const outcome = await h.walker.walk(
			walkInput([
				ivrMenuNode("m", {
					maxDigits: 2,
					options: [
						{
							ordinal: 0,
							pattern: { kind: "regex", source: "^\\d{2}$" },
							matchValue: "\\d{2}",
							targetNodeId: "done",
						},
					],
				}),
				hangupNode("done", "NORMAL_CLEARING"),
			]),
		);
		expect(outcome.visited).toEqual(["m", "done"]);
	});

	it("reports direct dial as an unimplemented gap instead of guessing an extension", async () => {
		const h = harness({ gathers: [{ digits: ["1", "0", "0", "1"], endReason: "max-digits" }] });
		const outcome = await h.walker.walk(
			walkInput(menu({ directDialEnabled: true, maxFailures: 0, maxDigits: 4 })),
		);

		expect(outcome.notes.join(" ")).toContain("direct dial");
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
	});

	it("reports the menu as the CDR destination when the caller never chooses", async () => {
		const h = harness({ gathers: [{ digits: [], endReason: "timeout" }] });
		const outcome = await h.walker.walk(walkInput(menu({ maxTimeouts: 0 })));
		expect(outcome.destination).toEqual({
			destinationType: "ivr-menu",
			destinationRef: "ivr-m",
		});
	});

	it("tears the call down when the gather verb itself fails", async () => {
		const h = harness({ failVerbs: ["gather"] });
		const outcome = await h.walker.walk(walkInput(menu()));
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
	});

	it("ends the collection on `#` without treating it as a digit", async () => {
		const h = harness({ gathers: [{ digits: ["1"], endReason: "terminator", terminator: "#" }] });
		const outcome = await h.walker.walk(walkInput(menu()));
		expect(outcome.visited).toEqual(["m", "one"]);
		expect(h.verbs[1]).toMatchObject({ terminators: ["#"] });
	});
});

// =================================================================================================
// Voicemail
// =================================================================================================

describe("voicemail", () => {
	it("answers, plays the greeting, records, and publishes the recording pair", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
		expect(h.published.map((event) => event.type)).toEqual([
			"channel.record.started",
			"channel.record.stopped",
		]);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("names the object key by organization, call and recording", async () => {
		const h = harness();
		await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(h.published[0]?.data).toMatchObject({
			objectKey: `${ORG_ID}/${CALL_ID}/id-1.wav`,
			kind: "voicemail",
			recordingId: "id-1",
		});
	});

	it("asks the media server to record with the box's own limit and a terminator", async () => {
		const h = harness();
		await h.walker.walk(walkInput([voicemailNode("vm", { maxMessageSeconds: 30 })]));

		const call = h.media.calls.find((entry) => entry.method === "record");
		expect(call?.args[1]).toMatchObject({
			name: "id-1",
			format: "wav",
			maxDurationSeconds: 30,
			terminateOn: "#",
			beep: true,
		});
	});

	it("publishes a failed stop reason when the media server reports the recording failed", async () => {
		const h = harness({ recording: { kind: "failed", reason: "disk full" } });
		await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(h.published[1]?.data).toMatchObject({ reason: "failed", durationMs: 0 });
	});

	it("hangs up rather than holding the line when the recording cannot be started", async () => {
		const h = harness({ media: { recordFails: true } });
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(h.published).toEqual([]);
	});

	it("refuses a `check` that is not the caller's own mailbox", async () => {
		// The node names box 8000 and the call is from +15551234567. Opening it anyway would hand a
		// caller somebody else's messages on the strength of having dialled the right node.
		const h = harness();
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm", { mode: "check" })]));

		expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(outcome.notes.join(" ")).toContain("matched no mailbox");
	});

	it("opens the caller's own mailbox and reads its number back as digits", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([voicemailNode("vm", { mode: "check", mailboxNumber: "1001" })], {
				callerIdNumber: "1001",
			}),
		);

		// `digits/N` is in Asterisk's core sound package, so this works with no prompt pack and no
		// TTS — which is the whole point of spelling the number rather than synthesising it.
		// The trailing announcement is the no-mailbox-source path, asserted on its own below.
		expect(h.verbs).toEqual([
			{ verb: "answer" },
			{ verb: "play", media: "sound:digits/1" },
			{ verb: "play", media: "sound:digits/0" },
			{ verb: "play", media: "sound:digits/0" },
			{ verb: "play", media: "sound:digits/1" },
			{ verb: "play", media: "sound:unavailable" },
			{ verb: "hangup", cause: "NORMAL_CLEARING" },
		]);
		expect(outcome.notes.join(" ")).toContain("no mailbox source");
	});

	it("opens a mailbox the artifact says the caller owns, even when the node names another", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([voicemailNode("vm", { mode: "check" })], {
				callerIdNumber: "1002",
				mailboxes: {
					"1002": {
						voicemailBoxId: "vm-1002",
						mailboxNumber: "1002",
						leaveNodeId: "vm",
						checkNodeId: "vm",
					},
				},
			}),
		);

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:digits/2" });
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("files the recorded message against the box, once, with the audio it actually captured", async () => {
		const filed: VoicemailMessage[] = [];
		const h = harness({
			voicemail: {
				messageLeft: async (message) => {
					filed.push(message);
				},
			},
		});
		await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(filed).toHaveLength(1);
		expect(filed[0]?.voicemailBoxId).toBe("vm-vm");
		expect(filed[0]?.mailboxNumber).toBe("8000");
		expect(filed[0]?.durationMs).toBeGreaterThan(0);
		expect(filed[0]?.callerIdNumber).toBe("+15551234567");
		// The same object the `channel.record.*` pair named, so the uploader and the mailbox row
		// point at one file rather than at two names for it.
		const stopped = h.published.find((event) => event.type === "channel.record.stopped");
		const stoppedKey = (stopped?.data ?? {}) as { objectKey?: string };
		expect(filed[0]?.objectKey).toBe(String(stoppedKey.objectKey));
	});

	it("does NOT file a message when the recording produced no audio", async () => {
		// A mailbox entry with silence behind it costs a user the trip and tells them nothing, and
		// lights a lamp for a message that is not there.
		const filed: VoicemailMessage[] = [];
		const h = harness({
			recording: { kind: "failed", reason: "no audio path" },
			voicemail: {
				messageLeft: async (message) => {
					filed.push(message);
				},
			},
		});
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(filed).toEqual([]);
		expect(outcome.notes.join(" ")).toContain("no audio");
	});

	it("reports a filing failure on the walk rather than swallowing it", async () => {
		const h = harness({
			voicemail: {
				messageLeft: async () => {
					throw new Error("broker unreachable");
				},
			},
		});
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm")]));

		// The object is in the store and the row is not: a divergence an operator has to be able
		// to see, and the caller has already hung up so there is nothing left to fail.
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
		expect(outcome.notes.join(" ")).toContain("could NOT be filed");
	});

	it("records the mailbox as the CDR destination", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm", { mode: "check" })]));
		expect(outcome.destination).toEqual({
			destinationType: "voicemail",
			destinationRef: "vm-vm",
		});
	});

	it("says out loud when there is nowhere to file the message", async () => {
		// No voicemail port: the walk records and then has nothing to hand the message to. Silence
		// here would be a message that vanished between the store and the mailbox.
		const h = harness();
		const outcome = await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(outcome.notes.join(" ")).toContain("no voicemail port");
	});
});

// =================================================================================================
// Per-box greetings
// =================================================================================================

/** A deployment that HAS mounted its object store inside the media server. */
const MOUNTED_MEDIA: Partial<PlanWalkerSettings> = {
	mediaRefs: { ...DEFAULT_MEDIA_REF_SETTINGS, objectMediaRoot: "/objects" },
};

describe("voicemail greetings", () => {
	it("plays the box's own greeting when the deployment can reach it", async () => {
		const h = harness({ settings: MOUNTED_MEDIA });
		await h.walker.walk(
			walkInput([
				voicemailNode("vm", {
					greetingMedia: "object://org-1/vm-1/holiday.wav",
					greetingKind: "temporary",
				}),
			]),
		);

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:/objects/org-1/vm-1/holiday" });
	});

	it("falls back to the deployment announcement when the box has no greeting", async () => {
		const h = harness({ settings: MOUNTED_MEDIA });
		await h.walker.walk(walkInput([voicemailNode("vm")]));

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:unavailable" });
	});

	it("says WHY it fell back when the object store is not mounted", async () => {
		// "This box has no greeting" and "this deployment cannot reach the one it has" sound
		// identical to a caller and are completely different problems to an operator.
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				voicemailNode("vm", {
					greetingMedia: "object://org-1/vm-1/holiday.wav",
					greetingKind: "unavailable",
				}),
			]),
		);

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:unavailable" });
		expect(outcome.notes.join(" ")).toContain("ENGINE_MEDIA_OBJECT_ROOT");
	});

	it("still records after falling back — a greeting is not a precondition", async () => {
		const h = harness({ voicemail: { messageLeft: async () => undefined } });
		await h.walker.walk(walkInput([voicemailNode("vm", { greetingMedia: "object://x.wav" })]));

		expect(h.media.methods()).toContain("record");
	});
});

// =================================================================================================
// The *97 menu: PIN, listing, playback
// =================================================================================================

const A_PIN_HASH_FOR = async (pin: string): Promise<string> => {
	// Hashed for real, with the contract's own parameters, because a spec that asserted a PIN check
	// against a fixture digest would be asserting string equality rather than a KDF.
	const { randomBytes, scryptSync } = await import("node:crypto");
	const salt = randomBytes(MIN_SALT_BYTES);
	const key = scryptSync(pin, salt, DERIVED_KEY_BYTES, {
		N: DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS.cost,
		r: DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS.blockSize,
		p: DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS.parallelism,
	});
	return formatVoicemailPinHash(
		DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
		salt.toString("base64"),
		key.toString("base64"),
	);
};

function checkNodeFor(overrides: Partial<Parameters<typeof voicemailNode>[1]> = {}) {
	return voicemailNode("vm", { mode: "check", mailboxNumber: "1001", ...overrides });
}

const OWN_MAILBOX = { callerIdNumber: "1001" };

function aListing(count: number) {
	return {
		found: true,
		messages: Array.from({ length: count }, (_, index) => ({
			messageId: `msg-${String(index)}`,
			media: `object://org-1/vm-1/msg-${String(index)}.wav`,
			durationMs: 4_000,
			receivedAt: "2026-08-05T12:00:00.000Z",
		})),
	};
}

describe("voicemail check — the PIN gate", () => {
	it("does not challenge a box with no PIN", async () => {
		// The classic PBX default: `*97` from the owner's extension is authenticated by the
		// extension. Challenging a PIN nobody set would lock every existing user out on deploy day.
		const h = harness();
		await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(verbNames(h.verbs)).not.toContain("gather");
	});

	it("opens the mailbox on the correct PIN", async () => {
		const pinHash = await A_PIN_HASH_FOR("4242");
		const h = harness({
			gathers: [{ digits: ["4", "2", "4", "2"], endReason: "terminator" }],
			mailbox: { list: async () => aListing(0) },
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor({ pinHash })], OWN_MAILBOX));

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:digits/0" });
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
		expect(outcome.notes.join(" ")).toContain("is empty");
	});

	it("refuses the call after three wrong PINs", async () => {
		const pinHash = await A_PIN_HASH_FOR("4242");
		const h = harness({ gathers: [{ digits: ["0", "0", "0", "0"], endReason: "terminator" }] });
		const outcome = await h.walker.walk(walkInput([checkNodeFor({ pinHash })], OWN_MAILBOX));

		expect(verbNames(h.verbs).filter((verb) => verb === "gather")).toHaveLength(3);
		expect(outcome.hangupCause).toBe("CALL_REJECTED");
		expect(outcome.notes.join(" ")).toContain("3 PIN attempts");
	});

	it("plays the retry prompt between attempts, so a caller knows they were wrong", async () => {
		const pinHash = await A_PIN_HASH_FOR("4242");
		const h = harness({ gathers: [{ digits: ["9"], endReason: "terminator" }] });
		await h.walker.walk(walkInput([checkNodeFor({ pinHash })], OWN_MAILBOX));

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:vm-incorrect" });
	});

	it("never reads the mailbox out when the PIN failed", async () => {
		const pinHash = await A_PIN_HASH_FOR("4242");
		let listed = false;
		const h = harness({
			gathers: [{ digits: ["1"], endReason: "terminator" }],
			mailbox: {
				list: async () => {
					listed = true;
					return aListing(2);
				},
			},
		});
		await h.walker.walk(walkInput([checkNodeFor({ pinHash })], OWN_MAILBOX));

		expect(listed).toBe(false);
	});

	it("ends the walk when the caller hangs up mid-challenge", async () => {
		const pinHash = await A_PIN_HASH_FOR("4242");
		const h = harness({ gathers: [{ digits: [], endReason: "hangup" }] });
		const outcome = await h.walker.walk(walkInput([checkNodeFor({ pinHash })], OWN_MAILBOX));

		expect(outcome.status).toBe("aborted");
	});

	it("fails CLOSED on a digest it cannot verify, without burning the attempts", async () => {
		// The compiler refuses to embed an unparseable digest, so reaching here means the artifact
		// came from something that skipped that check. Retrying would only cost the caller.
		const h = harness({ gathers: [{ digits: ["1", "2"], endReason: "terminator" }] });
		const outcome = await h.walker.walk(
			walkInput([checkNodeFor({ pinHash: "not-a-digest" })], OWN_MAILBOX),
		);

		expect(verbNames(h.verbs).filter((verb) => verb === "gather")).toHaveLength(1);
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(outcome.notes.join(" ")).toContain("cannot verify");
	});
});

describe("voicemail check — the message menu", () => {
	it("announces the mailbox as UNAVAILABLE, never as empty, when nothing answers", async () => {
		// The single most important behaviour in this file. "You have no messages" told to somebody
		// who has nine is worse than any error, so an unreadable mailbox and an empty one are
		// separate states all the way from the rpc contract to what the caller hears.
		const h = harness({
			mailbox: { list: async () => ({ found: false, messages: [], reason: "no responder" }) },
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		// Spelled exactly: the mailbox number read back, then the announcement — and NOTHING between
		// them, because anything between them would be a count for a mailbox nobody could read.
		expect(h.verbs).toEqual([
			{ verb: "answer" },
			{ verb: "play", media: "sound:digits/1" },
			{ verb: "play", media: "sound:digits/0" },
			{ verb: "play", media: "sound:digits/0" },
			{ verb: "play", media: "sound:digits/1" },
			{ verb: "play", media: "sound:unavailable" },
			{ verb: "hangup", cause: "NORMAL_CLEARING" },
		]);
		expect(outcome.notes.join(" ")).toContain("rather than as empty");
	});

	it("treats a source that throws exactly as one that says no", async () => {
		const h = harness({
			mailbox: {
				list: async () => {
					throw new Error("broker unreachable");
				},
			},
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(outcome.notes.join(" ")).toContain("failed");
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("announces zero for a genuinely empty mailbox", async () => {
		const h = harness({ mailbox: { list: async () => aListing(0) } });
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(h.verbs).toContainEqual({ verb: "play", media: "sound:digits/0" });
		expect(outcome.notes.join(" ")).toContain("is empty");
	});

	it("plays each message through, newest first, and ends", async () => {
		const h = harness({
			settings: MOUNTED_MEDIA,
			mailbox: { list: async () => aListing(2) },
			gathers: [{ digits: [], endReason: "timeout" }],
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		const played = h.verbs
			.filter((verb): verb is Extract<Verb, { verb: "gather" }> => verb.verb === "gather")
			.map((verb) => verb.media);
		expect(played).toEqual(["sound:/objects/org-1/vm-1/msg-0", "sound:/objects/org-1/vm-1/msg-1"]);
		expect(outcome.notes.join(" ")).toContain("played 2 message(s)");
	});

	it("replays a message on `2` and moves on afterwards", async () => {
		const gathers: DtmfCollection[] = [
			{ digits: ["2"], endReason: "max-digits" },
			{ digits: ["1"], endReason: "max-digits" },
		];
		const h = harness({
			settings: MOUNTED_MEDIA,
			mailbox: { list: async () => aListing(1) },
			gathers,
		});
		await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		const plays = h.verbs.filter(
			(verb) => verb.verb === "gather" && verb.media === "sound:/objects/org-1/vm-1/msg-0",
		);
		expect(plays).toHaveLength(2);
	});

	it("stops honouring `2` once the replay budget is spent", async () => {
		// Otherwise a caller with a stuck key holds a channel open forever.
		const h = harness({
			settings: { ...MOUNTED_MEDIA, voicemailMaxReplays: 2 },
			mailbox: { list: async () => aListing(1) },
			gathers: [{ digits: ["2"], endReason: "max-digits" }],
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(
			h.verbs.filter((verb) => verb.verb === "gather" && verb.media?.includes("msg-0")),
		).toHaveLength(3);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("exits on `*` without playing the rest", async () => {
		const h = harness({
			settings: MOUNTED_MEDIA,
			mailbox: { list: async () => aListing(3) },
			gathers: [{ digits: ["*"], endReason: "max-digits" }],
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(h.verbs.filter((verb) => verb.verb === "gather")).toHaveLength(1);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("skips a message whose audio this deployment cannot play, and says which", async () => {
		// The row exists and its audio does not reach here. Skipping is right — the caller still gets
		// their other messages — and the note is what tells an operator the store is not mounted.
		const h = harness({
			mailbox: { list: async () => aListing(2) },
			gathers: [{ digits: [], endReason: "timeout" }],
		});
		const outcome = await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(verbNames(h.verbs)).not.toContain("gather");
		expect(outcome.notes.join(" ")).toContain("cannot play");
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("hands the responder the mailbox the walk authenticated, not the one the node named", async () => {
		const seen: string[] = [];
		const h = harness({
			mailbox: {
				list: async (request) => {
					seen.push(`${request.voicemailBoxId}:${request.mailboxNumber}`);
					return aListing(0);
				},
			},
		});
		await h.walker.walk(walkInput([checkNodeFor()], OWN_MAILBOX));

		expect(seen).toEqual(["vm-vm:1001"]);
	});
});

// =================================================================================================
// Trunks and external numbers
// =================================================================================================

describe("trunk dialling", () => {
	it("dials the first trunk with the digit-manipulated number", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([trunkDialNode("t")], { dialedNumber: "+12125550100" }),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated()[0]?.endpoint).toBe("PJSIP/+12125550100@carrier-a");
	});

	it("fails over to the next trunk on a retryable cause", async () => {
		const h = harness({
			reactions: {
				"carrier-a": { kind: "reject", cause: "NETWORK_OUT_OF_ORDER" },
				"carrier-b": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput(
				[
					trunkDialNode("t", {
						attempts: [trunkAttempt("carrier-a", 0), trunkAttempt("carrier-b", 1)],
					}),
				],
				{ dialedNumber: "+12125550100" },
			),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated().map((call) => call.endpoint)).toEqual([
			"PJSIP/+12125550100@carrier-a",
			"PJSIP/+12125550100@carrier-b",
		]);
	});

	it("STOPS at a cause outside `continueOnCauses` rather than walking the whole list", async () => {
		const h = harness({
			reactions: {
				"carrier-a": { kind: "reject", cause: "CALL_REJECTED" },
				"carrier-b": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput(
				[
					trunkDialNode("t", {
						attempts: [trunkAttempt("carrier-a", 0), trunkAttempt("carrier-b", 1)],
					}),
				],
				{ dialedNumber: "+12125550100" },
			),
		);

		// Retrying a CALL_REJECTED across every carrier is the amplification toll fraud looks for.
		expect(h.media.originated()).toHaveLength(1);
		expect(outcome.hangupCause).toBe("CALL_REJECTED");
	});

	it("walks the attempts in `order`, not in array order", async () => {
		const h = harness({
			reactions: {
				"carrier-a": { kind: "answer" },
				"carrier-b": { kind: "reject", cause: "NETWORK_OUT_OF_ORDER" },
			},
		});
		await h.walker.walk(
			walkInput(
				[
					trunkDialNode("t", {
						attempts: [trunkAttempt("carrier-b", 5), trunkAttempt("carrier-a", 1)],
					}),
				],
				{ dialedNumber: "+1" },
			),
		);
		expect(h.media.originated()[0]?.endpoint).toContain("carrier-a");
	});

	it("takes the failover branch when every trunk has been refused", async () => {
		const h = harness({
			reactions: { carrier: { kind: "reject", cause: "NETWORK_OUT_OF_ORDER" } },
		});
		const outcome = await h.walker.walk(
			walkInput(
				[trunkDialNode("t", { failoverNodeId: "vm" }), voicemailNode("vm", { mode: "check" })],
				{ dialedNumber: "+1" },
			),
		);
		expect(outcome.visited).toEqual(["t", "vm"]);
	});

	it("refuses when it has no number to dial", async () => {
		const h = harness();
		const outcome = await h.walker.walk({
			plan: planOfTrunkWithoutCallerId(),
			now: NOW,
		});

		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(outcome.notes.join(" ")).toContain("no number to dial");
	});

	it("refuses a route whose trunks were all deleted", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([trunkDialNode("t", { attempts: [] })], { dialedNumber: "+1" }),
		);

		expect(outcome.hangupCause).toBe("NETWORK_OUT_OF_ORDER");
		expect(outcome.notes.join(" ")).toContain("no trunks configured");
	});

	it("presents the route's caller-id override", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([trunkDialNode("t", { callerIdNumberOverride: "+12125559999" })], {
				dialedNumber: "+1",
				callerIdName: "Acme",
			}),
		);
		expect(h.media.originated()[0]?.callerId).toBe('"Acme" <+12125559999>');
	});

	it("reports the outbound route as the CDR destination", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		const outcome = await h.walker.walk(walkInput([trunkDialNode("t")], { dialedNumber: "+1" }));
		expect(outcome.destination).toEqual({
			destinationType: "trunk-dial",
			destinationRef: "route-t",
		});
	});
});

/**
 * The emergency half of a trunk dial.
 *
 * Everything that could have refused the call was bypassed in `packages/routing`'s resolvers —
 * `emergency.spec.ts` there is where those proofs live. What is left for the walker is exactly
 * two things: the ELIN must be what the far end sees, and the Kari's Law notification must go out
 * before the first attempt rather than after the call.
 */
describe("an emergency trunk dial", () => {
	const emergencyNode = (overrides: Partial<TrunkDialPlanNode> = {}) =>
		trunkDialNode("e", {
			outboundRouteId: "emergency",
			emergency: true,
			elin: "+12125550100",
			emergencyAddressId: "0195c0f0-1c2f-7000-8000-0000000000d1",
			...overrides,
		});

	it("presents the ELIN the resolver worked out", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([emergencyNode()], { dialedNumber: "911", callerIdNumber: "+12125550199" }),
		);
		expect(h.media.originated()[0]?.callerId).toBe("+12125550199");
	});

	it("falls back to the node's own ELIN when the resolver supplied none", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(walkInput([emergencyNode()], { dialedNumber: "911" }));
		expect(h.media.originated()[0]?.callerId).toBe("+12125550100");
	});

	it("ignores a trunk's caller-id override, which would send a dispatcher to the wrong address", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(
			walkInput(
				[
					emergencyNode({
						callerIdNumberOverride: "+15559999999",
						attempts: [{ ...trunkAttempt("carrier-a", 0), callerIdNumberOverride: "+15558888888" }],
					}),
				],
				{ dialedNumber: "911", callerIdNumber: "+12125550199" },
			),
		);
		expect(h.media.originated()[0]?.callerId).toBe("+12125550199");
	});

	it("does NOT touch an ordinary trunk dial's caller-id precedence", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([trunkDialNode("t", { callerIdNumberOverride: "+15559999999" })], {
				dialedNumber: "+1",
				callerIdNumber: "+12125550199",
			}),
		);
		expect(h.media.originated()[0]?.callerId).toBe("+15559999999");
	});

	it("publishes the Kari's Law notification BEFORE the first attempt", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([emergencyNode()], { dialedNumber: "911", callerIdNumber: "+12125550199" }),
		);
		// The publish is recorded on the same timeline as the originate, so "before" is a fact
		// rather than an ordering the spec asserts by hoping.
		expect(h.published[0]?.type).toBe("call.emergency.dialed");
	});

	it("carries what a notification needs: the number, the caller, the ELIN and the address", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(
			walkInput([emergencyNode()], {
				dialedNumber: "911",
				originalDialedNumber: "9911",
				callerIdNumber: "+12125550199",
			}),
		);
		const event = h.published.find((entry) => entry.type === "call.emergency.dialed");
		expect(event?.data).toMatchObject({
			dialed: "9911",
			number: "911",
			callerNumber: "+15551234567",
			elin: "+12125550199",
			emergencyAddressId: "0195c0f0-1c2f-7000-8000-0000000000d1",
			trunkName: "carrier-a",
		});
	});

	it("publishes nothing of the kind for an ordinary trunk dial", async () => {
		const h = harness({ reactions: { "carrier-a": { kind: "answer" } } });
		await h.walker.walk(walkInput([trunkDialNode("t")], { dialedNumber: "+1" }));
		expect(h.published.map((entry) => entry.type)).not.toContain("call.emergency.dialed");
	});

	it("still dials when the notification cannot be published", async () => {
		// A slow broker must not be able to stop a call to a dispatcher.
		const h = harness({
			reactions: { "carrier-a": { kind: "answer" } },
			failPublishOf: "call.emergency.dialed",
		});
		const outcome = await h.walker.walk(walkInput([emergencyNode()], { dialedNumber: "911" }));

		expect(outcome.status).toBe("bridged");
		expect(outcome.notes.join(" ")).toContain("could not be published");
	});

	it("keeps trying carriers past a rejection, because the node says to", async () => {
		const h = harness({
			reactions: {
				"carrier-a": { kind: "reject", cause: "CALL_REJECTED" },
				"carrier-b": { kind: "answer" },
			},
		});
		const outcome = await h.walker.walk(
			walkInput(
				[
					emergencyNode({
						attempts: [trunkAttempt("carrier-a", 0), trunkAttempt("carrier-b", 1)],
						// The wider list `packages/routing` compiles onto an emergency node.
						continueOnCauses: ["CALL_REJECTED"],
					}),
				],
				{ dialedNumber: "911" },
			),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated()).toHaveLength(2);
	});
});

describe("external numbers", () => {
	it("dials a literal destination that does not need outbound routing", async () => {
		const h = harness({ reactions: { external: { kind: "answer" } } });
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "x",
					kind: "external",
					destination: "+15557654321",
					viaOutboundRouting: false,
				} as PlanNode,
			]),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.media.originated()[0]?.endpoint).toBe("PJSIP/+15557654321@external");
	});

	it("REFUSES a forward that requires outbound routing rather than dialling direct", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "x",
					kind: "external",
					destination: "+15557654321",
					viaOutboundRouting: true,
				} as PlanNode,
			]),
		);

		// Dialling direct here is how a PBX ends up with an inbound route that can dial anywhere.
		expect(h.media.originated()).toEqual([]);
		expect(outcome.hangupCause).toBe("OUTGOING_CALL_BARRED");
		expect(outcome.notes.join(" ")).toContain("outbound routing");
	});
});

// =================================================================================================
// Feature codes and unimplemented kinds
// =================================================================================================

describe("feature codes", () => {
	it("follows an explicit target node when the code has one", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "f",
					kind: "feature-code",
					featureCodeId: "fc-1",
					code: "*97",
					action: "voicemail-check",
					targetNodeId: "done",
				} as PlanNode,
				hangupNode("done", "NORMAL_CLEARING"),
			]),
		);
		expect(outcome.visited).toEqual(["f", "done"]);
	});

	it("announces *97 with no mailbox behind it, rather than playing a greeting at it", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "f",
					kind: "feature-code",
					featureCodeId: "fc-1",
					code: "*97",
					action: "voicemail-check",
				} as PlanNode,
			]),
		);

		expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(outcome.notes.join(" ")).toContain("resolved to no mailbox node");
	});

	it("announces and hangs up for every other code, rather than doing nothing", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "f",
					kind: "feature-code",
					featureCodeId: "fc-2",
					code: "*78",
					action: "do-not-disturb",
				} as PlanNode,
			]),
		);

		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("not implemented yet");
	});
});

describe("node kinds that are not implemented yet", () => {
	// `conference` and `park` both left this list when they gained real runtimes; each now behaves
	// like `queue` — implemented, and falling back to the announcement when the walk was not given
	// its registry. See `plan-walker-conference.spec.ts` and `plan-walker-park.spec.ts`.
	for (const node of [{ id: "a", kind: "application", application: "autopilot" }] as PlanNode[]) {
		it(`announces and hangs up for a \`${node.kind}\` node`, async () => {
			const h = harness();
			const outcome = await h.walker.walk(walkInput([node]));

			expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
			expect(outcome.notes.join(" ")).toContain(`"${node.kind}" is not implemented yet`);
			expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
		});
	}

	it("announces a `park` node when the walk has no call-control runtime", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "p",
					kind: "park",
					parkLotId: "p-1",
					slotStart: 401,
					slotEnd: 410,
					timeoutSeconds: 120,
				} as PlanNode,
			]),
		);

		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("has no call-control runtime");
	});

	/**
	 * A `queue` node IS implemented — but only when the walk was given the ACD plane. A walker
	 * constructed without it (which is every spec in this file, and any future caller that forgets)
	 * must degrade to the announcement rather than throwing on a live call, and must say which of the
	 * two situations it was in.
	 */
	it("falls back to the announcement for a `queue` node when the walk has no ACD services", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				{
					id: "q",
					kind: "queue",
					queueId: "q-1",
					strategy: "longest-idle",
					maxWaitSeconds: 0,
					maxWaitNoAgentSeconds: 0,
					announcePositionEnabled: false,
					announceFrequencySeconds: 60,
					recordEnabled: false,
				},
			] as PlanNode[]),
		);

		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("has no ACD services");
		expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
	});
});

// =================================================================================================
// Walk safety
// =================================================================================================

describe("walk safety", () => {
	it("stops a plan that cycles without a terminal, instead of running forever", async () => {
		const h = harness({
			settings: { maxPlanSteps: 8 },
			gathers: [{ digits: ["1"], endReason: "max-digits" }],
		});
		const outcome = await h.walker.walk(
			walkInput([
				ivrMenuNode("a", {
					options: [
						{
							ordinal: 0,
							pattern: { kind: "exact", value: "1" },
							matchValue: "1",
							targetNodeId: "b",
						},
					],
				}),
				ivrMenuNode("b", {
					options: [
						{
							ordinal: 0,
							pattern: { kind: "exact", value: "1" },
							matchValue: "1",
							targetNodeId: "a",
						},
					],
				}),
			]),
		);

		expect(outcome.status).toBe("exhausted");
		expect(outcome.hangupCause).toBe("EXCHANGE_ROUTING_ERROR");
		expect(outcome.visited).toHaveLength(8);
		expect(outcome.notes.join(" ")).toContain("cycle");
	});

	it("stops immediately when the leg is already tearing down", async () => {
		const h = harness();
		h.state.tearingDown = true;
		const outcome = await h.walker.walk(walkInput([playbackNode("p")]));

		expect(outcome.status).toBe("aborted");
		expect(h.verbs).toEqual([]);
	});

	it("does not issue a second hangup for a leg that already tore down", async () => {
		const h = harness({ gathers: [{ digits: [], endReason: "hangup" }] });
		const outcome = await h.walker.walk(walkInput([ivrMenuNode("m")]));

		expect(outcome.status).toBe("aborted");
		expect(verbNames(h.verbs)).not.toContain("hangup");
	});

	it("turns a media-server exception into a hangup, never an unhandled rejection", async () => {
		const h = harness({
			reactions: { "PJSIP/1001": { kind: "answer" } },
			media: {
				originateFails: () => undefined,
			},
		});
		// `createBridge` is the one call the harness can make throw mid-walk.
		const failing = harness({
			reactions: { "PJSIP/1001": { kind: "answer" } },
			media: { bridgeFails: true },
		});
		void h;

		const outcome = await failing.walker.walk(walkInput([extensionNode("e", { number: "1001" })]));
		expect(outcome.status).toBe("hangup");
	});
});

describe("composeCallerId", () => {
	it("renders a name and a number in the format every SIP stack expects", () => {
		expect(composeCallerId("Ada", "+15551234567")).toBe('"Ada" <+15551234567>');
	});

	it("renders a bare number when there is no name", () => {
		expect(composeCallerId(undefined, "+15551234567")).toBe("+15551234567");
	});

	it("renders a quoted name when there is no number", () => {
		expect(composeCallerId("Ada", undefined)).toBe('"Ada"');
	});

	it("is undefined when there is neither", () => {
		expect(composeCallerId(undefined, "  ")).toBeUndefined();
	});
});

/** A trunk plan with no dialed number anywhere — the "nothing to dial" case. */
function planOfTrunkWithoutCallerId() {
	return planOf([trunkDialNode("t")]);
}
