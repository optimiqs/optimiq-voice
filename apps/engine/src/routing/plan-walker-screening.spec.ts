import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "./call-signals";
import { extensionNode, planOf, voicemailNode } from "./plan-fixtures.fake";
import { DEFAULT_PLAN_WALKER_SETTINGS, PlanWalker } from "./plan-walker";
import type { WalkerChannel, WalkInput } from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { PlanNode } from "@optimiq-voice/routing";
import type { Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * Call screening: record the caller's name, let the callee accept or refuse.
 *
 * ## The two halves, and why the first one is specced harder than the second
 *
 * The PLUMBING is complete and always on — `ExtensionPlanNode.callScreening` is read, it sits in the
 * documented precedence chain, and a tenant who ticks the box has the fact travel all the way to the
 * walker. The RUNTIME is behind {@link PlanWalkerSettings.callScreeningEnabled}, which is `false`,
 * because it has named gaps (silence for the caller while the callee decides; no cleanup for the
 * recorded name) that `PlanWalker.screenCall` sets out.
 *
 * So the specs that matter most are the ones about the SWITCH: compiled-and-disabled must ring the
 * phone exactly as it did before the feature existed, and it must say in the notes that it did.
 * A default-on feature discovered by a customer is the outcome this arrangement exists to prevent,
 * and a spec that only exercised the enabled path would not notice if the default flipped.
 *
 * ## Driving the callee's keypad
 *
 * The confirmation is asked by playing at the CALLEE's channel and waiting for a `dtmf` signal on
 * that leg. So the harness hangs the answer off `media.play`: whatever the callee is configured to
 * press arrives the moment the question starts, which is the same ordering a real handset produces
 * and the only one that cannot race the subscription.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";
const EXTERNAL = "+15551234567";

const RECORD_PROMPT = DEFAULT_PLAN_WALKER_SETTINGS.screeningRecordPrompt;
const INTRO_PROMPT = DEFAULT_PLAN_WALKER_SETTINGS.screeningIntroPrompt;
const CONFIRM_PROMPT = DEFAULT_PLAN_WALKER_SETTINGS.confirmPrompt;

interface HarnessOptions {
	/** Whether the deployment has the runtime switched on. Default `false`, as in production. */
	readonly enabled?: boolean;
	/** What the callee presses when the question starts. Absent means they press nothing. */
	readonly calleePresses?: string;
	/** Makes the name recording produce nothing, which must not stop the screen. */
	readonly recordingFails?: boolean;
	/** The number the call presents. Defaults to an off-net one, which is what gets screened. */
	readonly caller?: string;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const published: { readonly type: CallEvent }[] = [];
	const state = { answered: false, tearingDown: false };
	/** Every `play` the media port was asked for, as `channelId → media list`. */
	const plays: { readonly channelId: string; readonly media: readonly string[] }[] = [];

	const media = makeFakeMediaPort({
		onOriginate: (request) => {
			signals.emit(legSignalKey(request.channelId), { kind: "answered" });
		},
		onRecord: (_channelId, request) => {
			signals.emit(
				recordingSignalKey(request.name),
				options.recordingFails === true
					? { kind: "recording-failed", reason: "no audio" }
					: { kind: "recording-finished", durationMs: 2_100 },
			);
		},
	});

	const play = media.play.bind(media);
	(media as { play: typeof media.play }).play = async (channelId, request) => {
		plays.push({ channelId, media: request.media });
		const handle = await play(channelId, request);
		// The callee's keypad. Only ever fired at a leg that is NOT the caller's, so the screening
		// prompt played at the caller cannot accidentally answer its own question.
		if (channelId !== A_CHANNEL && options.calleePresses !== undefined) {
			// A TICK later, not synchronously. `confirmAnswer` awaits the play and only then registers
			// the digit offer, so a keypress delivered inside the play call would arrive before anybody
			// was listening — which is a race a real handset cannot win and a fake should not invent.
			setTimeout(() => {
				signals.emit(legSignalKey(channelId), {
					kind: "dtmf",
					digit: options.calleePresses as string,
				});
			}, 0);
		}
		return handle;
	};

	const channel: WalkerChannel = {
		mediaChannelId: A_CHANNEL,
		channelId: A_LEG_ID,
		callId: CALL_ID,
		organizationId: ORG_ID,
		callerIdNumber: options.caller ?? EXTERNAL,
		isDetached: false,
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
		publish: async (type) => {
			published.push({ type });
		},
		settings: {
			answerTimeoutMs: 200,
			// Short, because a callee who presses nothing is a real case these specs exercise and the
			// walker waits it out for real.
			confirmTimeoutMs: 50,
			...(options.enabled === true ? { callScreeningEnabled: true } : {}),
		},
		newId: () => {
			counter += 1;
			return `id-${String(counter)}`;
		},
		delay: async () => undefined,
	});

	return { walker, media, verbs, published, plays };
}

function walkInput(nodes: readonly PlanNode[], extra: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), ...extra };
}

/** The screening recording, as the media server's own `recording:` scheme names it. */
function recordedName(media: {
	readonly calls: readonly { readonly method: string; readonly args: readonly unknown[] }[];
}): string {
	const recorded = media.calls.find((call) => call.method === "record");
	if (recorded === undefined) {
		throw new Error("no screening recording was started");
	}
	return `recording:${(recorded.args[1] as { readonly name: string }).name}`;
}

/** What the CALLER was played, through the verb executor. */
function askedOfCaller(verbs: readonly Verb[]): readonly string[] {
	return verbs
		.filter((verb): verb is Extract<Verb, { verb: "play" }> => verb.verb === "play")
		.map((verb) => verb.media);
}

/** What the CALLEE's leg was asked, as one flat list. The question the screen actually poses. */
function askedOfCallee(
	plays: readonly { readonly channelId: string; readonly media: readonly string[] }[],
): readonly string[] {
	return plays.filter((entry) => entry.channelId !== A_CHANNEL).flatMap((entry) => entry.media);
}

describe("call screening, compiled but switched off", () => {
	it("rings the phone exactly as it did before the flag existed", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([extensionNode("ext", { number: "1001", callScreening: true })]),
		);

		expect(outcome.status).toBe("bridged");
		// Nothing asked of the caller, nothing asked of the callee: this is a plain dial.
		expect(askedOfCaller(h.verbs)).not.toContain(RECORD_PROMPT);
		expect(askedOfCallee(h.plays)).toEqual([]);
	});

	it("says in the notes that a configured screen was not applied", async () => {
		// A tenant who ticked the box and sees no screen has to be able to find out why from the call
		// log rather than from the source.
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([extensionNode("ext", { number: "1001", callScreening: true })]),
		);

		expect(outcome.notes.join(" ")).toContain("screening runtime switched off");
	});
});

describe("call screening, switched on", () => {
	const screened = extensionNode("ext", {
		number: "1001",
		callScreening: true,
		noAnswerNodeId: "vm",
	});
	const mailbox = voicemailNode("vm", { mailboxNumber: "1001" });

	it("records the caller's name and plays it to the callee between the two prompts", async () => {
		const h = harness({ enabled: true, calleePresses: "1" });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.status).toBe("bridged");
		// The caller was asked for a name...
		expect(h.verbs.some((verb) => verb.verb === "play" && verb.media === RECORD_PROMPT)).toBe(true);
		const recorded = h.media.calls.find((call) => call.method === "record");
		expect(recorded?.args[0]).toBe(A_CHANNEL);
		// ...and the callee heard "call from", that recording, and the accept question, as ONE prompt.
		expect(askedOfCallee(h.plays)).toEqual([INTRO_PROMPT, recordedName(h.media), CONFIRM_PROMPT]);
	});

	it("bridges when the callee presses 1", async () => {
		const h = harness({ enabled: true, calleePresses: "1" });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.status).toBe("bridged");
		expect(outcome.visited).toEqual(["ext"]);
	});

	it("takes the extension's no-answer branch when the callee presses 2", async () => {
		// `2` is a refusal, and a refusal lands the caller where an unanswered phone would — which is
		// the whole reason the screen is built on the confirmation machinery rather than beside it.
		const h = harness({ enabled: true, calleePresses: "2" });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.visited).toEqual(["ext", "vm"]);
	});

	it("takes the same branch for a stray key as for a refusal", async () => {
		const h = harness({ enabled: true, calleePresses: "7" });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.visited).toEqual(["ext", "vm"]);
	});

	it("takes the same branch when the callee presses nothing at all", async () => {
		const h = harness({ enabled: true });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.visited).toEqual(["ext", "vm"]);
	});

	it("asks ONCE — a screen is a decision, not a question that needs repeating", async () => {
		const h = harness({ enabled: true });
		await h.walker.walk(walkInput([screened, mailbox]));

		expect(h.plays.filter((entry) => entry.channelId !== A_CHANNEL)).toHaveLength(1);
	});

	it("still screens when the name recording produced nothing, without the name", async () => {
		// The callee still gets the accept/reject question, which is most of the feature. Refusing the
		// call because a recording failed would drop calls over a media fault.
		const h = harness({ enabled: true, recordingFails: true, calleePresses: "1" });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.status).toBe("bridged");
		expect(askedOfCallee(h.plays)).toEqual([INTRO_PROMPT, CONFIRM_PROMPT]);
		expect(outcome.notes.join(" ")).toContain("produced nothing");
	});

	it("does NOT screen an INTERNAL caller, however the flag is set", async () => {
		// A colleague already arrives with a name on the display, and screening them would put ten
		// seconds on the front of every internal call. The rule is the engine's, not the artifact's.
		const h = harness({ enabled: true, caller: "2002", calleePresses: "1" });
		const outcome = await h.walker.walk(
			walkInput([screened, mailbox, extensionNode("caller", { number: "2002" })]),
		);

		expect(outcome.status).toBe("bridged");
		expect(askedOfCaller(h.verbs)).not.toContain(RECORD_PROMPT);
		expect(askedOfCallee(h.plays)).toEqual([]);
	});

	it("screens a caller with NO number, which is the call somebody turns this on for", async () => {
		const h = harness({ enabled: true, caller: "", calleePresses: "1" });
		const outcome = await h.walker.walk(walkInput([screened, mailbox]));

		expect(outcome.status).toBe("bridged");
		expect(askedOfCaller(h.verbs)).toContain(RECORD_PROMPT);
	});

	it("is outranked by do-not-disturb, which is a more specific thing to have said", async () => {
		const h = harness({ enabled: true, calleePresses: "1" });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					callScreening: true,
					doNotDisturb: true,
					busyNodeId: "vm",
				}),
				mailbox,
			]),
		);

		expect(outcome.visited).toEqual(["ext", "vm"]);
		expect(askedOfCaller(h.verbs)).not.toContain(RECORD_PROMPT);
	});

	it("is outranked by forward-all, so a forwarded caller is never asked to record", async () => {
		const h = harness({ enabled: true, calleePresses: "1" });
		const outcome = await h.walker.walk(
			walkInput([
				extensionNode("ext", {
					number: "1001",
					callScreening: true,
					forwardAllNodeId: "vm",
				}),
				mailbox,
			]),
		);

		expect(outcome.visited).toEqual(["ext", "vm"]);
		expect(askedOfCaller(h.verbs)).not.toContain(RECORD_PROMPT);
	});

	it("plays the recorded name at the CALLEE and never at the caller", async () => {
		// The caller does not need to be read their own name back, and hearing it would tell them a
		// screen is running — which is exactly what a screen is for not telling them.
		const h = harness({ enabled: true, calleePresses: "1" });
		await h.walker.walk(walkInput([screened, mailbox]));

		const name = recordedName(h.media);
		expect(askedOfCallee(h.plays)).toContain(name);
		expect(
			h.plays.filter((entry) => entry.channelId === A_CHANNEL).flatMap((e) => e.media),
		).not.toContain(name);
	});
});
