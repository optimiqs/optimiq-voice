import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "./call-signals";
import { extensionNode, featureCodeNode, planOf, voicemailNode } from "./plan-fixtures.fake";
import { DEFAULT_PLAN_WALKER_SETTINGS, PlanWalker } from "./plan-walker";
import type {
	ExtensionFeatureChange,
	ExtensionFeatureOutcome,
	LastCallerResult,
	RecordedGreeting,
	SupervisorAuthzRequest,
	WalkerCallControl,
	WalkerChannel,
	WalkInput,
	WalkStatus,
} from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { MailboxEntry, PlanNode } from "@optimiq-voice/routing";
import type { Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * The self-service star codes, as the plan walker executes them.
 *
 * Every collaborator is a port — the feature RPC, the call ledger, the greeting sink, call control
 * and the media server — so a `*72` runs in process with no broker and no Asterisk. What is asserted
 * here is the walker's own decisions and nothing else: WHICH state a bare code asks for, WHICH
 * announcement the answer produces, and that no path ends in silence. What the responder does with
 * the request is `apps/api`'s subject and is not re-tested through a second layer.
 *
 * The announcement is the assertion in most of these, and deliberately so. A feature code has no
 * visible outcome — the user's whole evidence that anything happened is what they hear — so a
 * runtime that took the right decision and played nothing would be indistinguishable from one that
 * did nothing at all.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";
const CALLER = "1001";

const ACTIVATED = DEFAULT_PLAN_WALKER_SETTINGS.featureActivatedAnnouncement;
const DEACTIVATED = DEFAULT_PLAN_WALKER_SETTINGS.featureDeactivatedAnnouncement;
const UNAVAILABLE = DEFAULT_PLAN_WALKER_SETTINGS.unavailableAnnouncement;

interface HarnessOptions {
	/** What the feature RPC answers. Absent means the walk has no feature port at all. */
	readonly feature?: ExtensionFeatureOutcome | "throws";
	/** What the ledger answers. Absent means the walk has no last-caller source at all. */
	readonly lastCaller?: LastCallerResult | "throws";
	/** Absent means the walk has nowhere to file a greeting. */
	readonly greetings?: "accepts" | "throws";
	/** How a `*69` return call to a non-extension resolves. Absent means no call-control runtime. */
	readonly dial?: { readonly status: WalkStatus | "unresolved"; readonly reason?: string };
	/**
	 * What the supervision GATE answers. Absent means the walk has no gate at all, which must DENY.
	 *
	 * A separate knob from {@link HarnessOptions.monitor} on purpose: the whole point of `*0` is that
	 * the gate runs before the runtime, so a spec has to be able to allow one and refuse the other.
	 */
	readonly authorize?: boolean | "throws";
	/** What the monitoring RUNTIME answers, once the gate has allowed the request. */
	readonly monitor?: { readonly ok: boolean; readonly reason?: string };
	/** Whether the walk gets a call-control runtime at all, independently of what it answers. */
	readonly control?: boolean;
	/**
	 * Makes every originated leg die instead of answering.
	 *
	 * A DEATH rather than silence, because silence would make the spec wait out a real ring timeout to
	 * assert something about the branch that is taken afterwards. What is under test is where the walk
	 * goes when the leg does not come up, and both roads lead there.
	 */
	readonly silentOriginate?: boolean;
	/** Makes the media plane refuse `echo`, which is what `mediad` does by name. */
	readonly echoFails?: boolean;
	/** How a started recording ends. Defaults to four seconds of audio. */
	readonly recording?:
		| { readonly kind: "finished"; readonly durationMs: number }
		| { readonly kind: "failed"; readonly reason: string };
	/** The number the call presents. Absent is how "a caller with no number" is exercised. */
	readonly callerNumber?: string | null;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const published: { readonly type: CallEvent }[] = [];
	const changes: ExtensionFeatureChange[] = [];
	const dials: { readonly destination: string }[] = [];
	const monitors: { readonly extension: string; readonly mode: string }[] = [];
	const authorized: SupervisorAuthzRequest[] = [];
	const filed: RecordedGreeting[] = [];
	const state = { answered: false, tearingDown: false };

	const media = makeFakeMediaPort({
		...(options.echoFails === true ? { echoFails: true } : {}),
		// Every leg these specs originate answers at once. Only `*69`'s on-net return call makes one,
		// and what it is there to prove is that the walk re-entered the extension runtime — not how
		// long a phone rings, which `plan-walker.spec.ts` already owns.
		onOriginate: (request) => {
			signals.emit(
				legSignalKey(request.channelId),
				options.silentOriginate === true
					? { kind: "ended", cause: "USER_NOT_REGISTERED", causeCode: 21 }
					: { kind: "answered" },
			);
		},
		onRecord: (_channelId, request) => {
			const reaction = options.recording ?? { kind: "finished" as const, durationMs: 4_200 };
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
		...(options.callerNumber === null ? {} : { callerIdNumber: options.callerNumber ?? CALLER }),
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
		if (verb.verb === "gather") {
			// No box in these specs carries a PIN, so nothing should ever reach here; a collection is
			// returned rather than `undefined` so a spec that accidentally triggers the gate fails on
			// the assertion it is about rather than on a media failure.
			return {
				verb: "gather",
				endReason: "timeout",
				collection: { digits: [], endReason: "timeout" },
				elapsedMs: 1,
			};
		}
		return { verb: verb.verb as never, endReason: "completed" };
	};

	const control: WalkerCallControl = {
		park: async () => ({ ok: false, reason: "not used by these specs" }),
		unpark: async () => ({ ok: false, reason: "not used by these specs" }),
		pickup: async () => ({ ok: false, reason: "not used by these specs" }),
		monitor: async (request) => {
			monitors.push(request);
			return options.monitor ?? { ok: true };
		},
		dial: async (request) => {
			dials.push(request);
			return options.dial ?? { status: "bridged" };
		},
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
		settings: { answerTimeoutMs: 200 },
		...(options.feature === undefined
			? {}
			: {
					features: {
						apply: async (change: ExtensionFeatureChange): Promise<ExtensionFeatureOutcome> => {
							changes.push(change);
							if (options.feature === "throws") {
								throw new Error("the broker is unreachable");
							}
							return options.feature as ExtensionFeatureOutcome;
						},
					},
				}),
		...(options.lastCaller === undefined
			? {}
			: {
					lastCaller: {
						lookup: async (): Promise<LastCallerResult> => {
							if (options.lastCaller === "throws") {
								throw new Error("the broker is unreachable");
							}
							return options.lastCaller as LastCallerResult;
						},
					},
				}),
		...(options.greetings === undefined
			? {}
			: {
					greetings: {
						greetingRecorded: async (greeting: RecordedGreeting): Promise<void> => {
							if (options.greetings === "throws") {
								throw new Error("the greeting could not be filed");
							}
							filed.push(greeting);
						},
					},
				}),
		...(options.authorize === undefined
			? {}
			: {
					supervision: {
						authorize: async (request: SupervisorAuthzRequest) => {
							authorized.push(request);
							if (options.authorize === "throws") {
								// The PORT never throws — `supervisor-authz.source.ts` catches and denies — so a
								// fake that threw would be testing a contract violation. It denies with the
								// reason the real one uses for an unreachable broker.
								return { allowed: false, reason: "the authorization service did not answer" };
							}
							return { allowed: options.authorize === true };
						},
					},
				}),
		...(options.dial === undefined &&
		options.lastCaller === undefined &&
		options.monitor === undefined &&
		options.control !== true
			? {}
			: { control }),
		newId: () => {
			counter += 1;
			return `id-${String(counter)}`;
		},
		delay: async () => undefined,
	});

	return { walker, media, verbs, published, changes, dials, filed, monitors, authorized };
}

/** The media a `play` verb was given, in order. The one thing a caller actually experiences. */
function played(verbs: readonly Verb[]): string[] {
	return verbs
		.filter((verb): verb is Extract<Verb, { verb: "play" }> => verb.verb === "play")
		.map((verb) => verb.media);
}

const MAILBOX: MailboxEntry = {
	voicemailBoxId: "vm-1001",
	mailboxNumber: CALLER,
	leaveNodeId: "leave",
	checkNodeId: "check",
};

function walkInput(nodes: readonly PlanNode[], overrides: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), ...overrides };
}

// =================================================================================================
// `*72` / `*74` / `*76` / `*78` / `*21` — the extension-feature write
// =================================================================================================

describe("call forwarding from the handset", () => {
	it("sets the destination the caller dialled after the code, and confirms", async () => {
		const h = harness({ feature: { applied: true, enabled: true, destination: "+15559990000" } });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-forward-all", code: "*72" })], {
				featureArgument: "+15559990000",
			}),
		);

		expect(h.changes).toEqual([
			{
				organizationId: ORG_ID,
				extensionNumber: CALLER,
				feature: "forward-all",
				enabled: true,
				destination: "+15559990000",
				callId: CALL_ID,
			},
		]);
		expect(played(h.verbs)).toEqual([ACTIVATED]);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("dialled alone against an extension whose forwarding is ON, asks for it to be cleared", async () => {
		const h = harness({ feature: { applied: true, enabled: false, destination: "+15559990000" } });
		await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "call-forward-all", code: "*72" }),
				// `forwardAllNodeId` is present exactly when the compiler saw forward-all switched on,
				// which is the whole of what makes a bare `*72` a toggle rather than a guess.
				extensionNode("ext", { number: CALLER, forwardAllNodeId: "somewhere" }),
			]),
		);

		expect(h.changes[0]).toMatchObject({ feature: "forward-all", enabled: false });
		expect(h.changes[0]?.destination).toBeUndefined();
	});

	it("dialled alone against an extension whose forwarding is OFF, asks for it to be switched on", async () => {
		const h = harness({ feature: { applied: true, enabled: true, destination: "+15559990000" } });
		await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "call-forward-all", code: "*72" }),
				extensionNode("ext", { number: CALLER }),
			]),
		);

		expect(h.changes[0]).toMatchObject({ feature: "forward-all", enabled: true });
		// No destination is sent: the stored one is the point of the toggle, and re-sending nothing
		// is what lets the responder reuse it.
		expect(h.changes[0]?.destination).toBeUndefined();
	});

	it("plays the announcement the ANSWER implies, not the one the request asked for", async () => {
		// A race with an admin editing the same row: the walk asked to switch on and the row came back
		// off. The user is told what is true.
		const h = harness({ feature: { applied: true, enabled: false } });
		await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-forward-all", code: "*72" })], {
				featureArgument: "2002",
			}),
		);

		expect(played(h.verbs)).toEqual([DEACTIVATED]);
	});

	it("treats a bare *74 as a CLEAR, because the artifact cannot say whether busy forwarding is on", async () => {
		const h = harness({ feature: { applied: true, enabled: false } });
		await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "call-forward-busy", code: "*74" }),
				// `busyNodeId` is populated whether the branch forwards or goes to voicemail, so it
				// cannot answer "is forwarding on?". Clearing is the harmless half of a wrong guess: the
				// responder keeps the stored destination either way.
				extensionNode("ext", { number: CALLER, busyNodeId: "vm" }),
			]),
		);

		expect(h.changes[0]).toMatchObject({ feature: "forward-busy", enabled: false });
	});

	it("announces unavailable when the responder refuses, and never a confirmation", async () => {
		const h = harness({
			feature: { applied: false, enabled: false, reason: "no destination stored" },
		});
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-forward-all", code: "*72" })]),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(outcome.notes.join(" ")).toContain("no destination stored");
	});

	it("announces unavailable when nothing answers, rather than leaving the line silent", async () => {
		const h = harness({ feature: "throws" });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-forward-all", code: "*72" })]),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
	});

	it("announces, and asks for nothing, when the walk has no feature port", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-forward-all", code: "*72" })]),
		);

		expect(h.changes).toEqual([]);
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("no feature port");
	});

	it("refuses a code dialled by a caller with no number, because there is no extension to change", async () => {
		const h = harness({ feature: { applied: true, enabled: true }, callerNumber: null });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-forward-all", code: "*72" })]),
		);

		expect(h.changes).toEqual([]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
	});
});

describe("do not disturb and follow me", () => {
	it("toggles do-not-disturb off when the artifact says it is on", async () => {
		const h = harness({ feature: { applied: true, enabled: false } });
		await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "do-not-disturb", code: "*78" }),
				extensionNode("ext", { number: CALLER, doNotDisturb: true }),
			]),
		);

		expect(h.changes[0]).toMatchObject({ feature: "do-not-disturb", enabled: false });
		expect(played(h.verbs)).toEqual([DEACTIVATED]);
	});

	it("toggles do-not-disturb on when the artifact says it is off", async () => {
		const h = harness({ feature: { applied: true, enabled: true } });
		await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "do-not-disturb", code: "*78" }),
				extensionNode("ext", { number: CALLER, doNotDisturb: false }),
			]),
		);

		expect(h.changes[0]).toMatchObject({ feature: "do-not-disturb", enabled: true });
		expect(played(h.verbs)).toEqual([ACTIVATED]);
	});

	it("never sends a destination for a code that has none, even when digits follow it", async () => {
		const h = harness({ feature: { applied: true, enabled: true } });
		await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "do-not-disturb", code: "*78" })], {
				// `*78` takes no argument, so trailing digits are not its to read. Reading them would
				// make a mis-dial set do-not-disturb "to 12".
				featureArgument: "12",
			}),
		);

		expect(h.changes[0]?.destination).toBeUndefined();
	});

	it("toggles follow-me off when the artifact carries a compiled ladder", async () => {
		const h = harness({ feature: { applied: true, enabled: false } });
		await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "follow-me", code: "*21" }),
				extensionNode("ext", {
					number: CALLER,
					// A ladder is compiled into the artifact exactly when it is switched on and has hops.
					followMe: { strategy: "sequential", ignoreBusy: true, destinations: [] },
				}),
			]),
		);

		expect(h.changes[0]).toMatchObject({ feature: "follow-me", enabled: false });
	});

	it("assumes a feature is ON for an extension the artifact does not contain", async () => {
		const h = harness({ feature: { applied: true, enabled: false } });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "do-not-disturb", code: "*78" })]),
		);

		// The inverse of "on" is a clear, which is the harmless half of a wrong guess.
		expect(h.changes[0]).toMatchObject({ enabled: false });
		expect(outcome.notes.join(" ")).toContain("not in this artifact");
	});
});

// =================================================================================================
// `*69` — the return call
// =================================================================================================

describe("returning the last call", () => {
	it("re-enters the extension runtime when the last caller is on-net", async () => {
		const h = harness({
			lastCaller: { found: true, callerNumber: "2002", at: "2026-08-05T09:00:00.000Z" },
		});
		const outcome = await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "redial", code: "*69" }),
				extensionNode("ext", { number: "2002" }),
			]),
		);

		// A `goto` and not a raw dial: the return call has to honour the CALLEE's own forwarding,
		// ladder and no-answer branch, which is exactly what the extension node already does.
		expect(outcome.visited).toEqual(["f", "ext"]);
		expect(outcome.status).toBe("bridged");
		expect(h.dials).toEqual([]);
	});

	it("asks call control to resolve an off-net number, rather than inventing a trunk for it", async () => {
		const h = harness({
			lastCaller: { found: true, callerNumber: "+15551234567" },
			dial: { status: "bridged" },
		});
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "redial", code: "*69" })]),
		);

		expect(h.dials).toEqual([{ destination: "+15551234567" }]);
		expect(outcome.status).toBe("bridged");
	});

	it("announces when nothing matched the number, rather than ending the call silently", async () => {
		const h = harness({
			lastCaller: { found: true, callerNumber: "+15551234567" },
			dial: { status: "unresolved", reason: "nothing matched it" },
		});
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "redial", code: "*69" })]),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("NO_ROUTE_DESTINATION");
	});

	it("announces an empty window", async () => {
		const h = harness({ lastCaller: { found: false, reason: "nobody called" } });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "redial", code: "*69" })]),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.notes.join(" ")).toContain("nobody has called");
	});

	it("announces a withheld caller, and says so rather than calling it an empty window", async () => {
		const h = harness({ lastCaller: { found: true, callerName: "Anonymous" } });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "redial", code: "*69" })]),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.notes.join(" ")).toContain("withheld their number");
	});

	it("announces when the ledger cannot be reached", async () => {
		const h = harness({ lastCaller: "throws" });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "redial", code: "*69" })]),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
	});

	it("announces when the walk has no last-caller source at all", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "redial", code: "*69" })]),
		);

		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("no last-caller source");
	});
});

// =================================================================================================
// `*43` — the echo test
// =================================================================================================

describe("the echo test", () => {
	it("answers, plays the preamble, and hands the leg to the media plane", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "echo-test", code: "*43" })]),
		);

		expect(h.media.methods()).toContain("echo");
		expect(played(h.verbs)).toEqual([DEFAULT_PLAN_WALKER_SETTINGS.echoTestPrompt]);
		// `bridged` means "the walk is over and the call is up" — the leg lives on inside the echo,
		// and the orchestrator must not tear it down when the walk returns.
		expect(outcome.status).toBe("bridged");
	});

	it("announces when the media plane cannot echo, instead of leaving the caller in silence", async () => {
		const h = harness({ echoFails: true });
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "echo-test", code: "*43" })]),
		);

		expect(outcome.status).toBe("hangup");
		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("cannot echo");
	});
});

// =================================================================================================
// `*99` — recording a greeting
// =================================================================================================

describe("recording a mailbox greeting", () => {
	const greetingPlan = (): readonly PlanNode[] => [
		featureCodeNode("f", { action: "voicemail-record-greeting", code: "*99" }),
		voicemailNode("check", { mode: "check", mailboxNumber: CALLER }),
		voicemailNode("leave", { mailboxNumber: CALLER }),
	];

	it("records the caller's own mailbox greeting and files it", async () => {
		const h = harness({ greetings: "accepts" });
		const outcome = await h.walker.walk(
			walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }),
		);

		expect(h.media.methods()).toContain("record");
		expect(h.filed).toHaveLength(1);
		expect(h.filed[0]).toMatchObject({
			voicemailBoxId: "vm-1001",
			mailboxNumber: CALLER,
			durationMs: 4_200,
			kind: "unavailable",
		});
		expect(played(h.verbs)).toEqual([DEFAULT_PLAN_WALKER_SETTINGS.greetingRecordedAnnouncement]);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
	});

	it("hands the filing port everything the contract needs to ingest the audio", async () => {
		// The port is a process-wide singleton over the shared rpc client — it has no call to close
		// over — so the tenant, the object key and the call travel WITH the greeting. The key is the
		// same one the `channel.record.*` pair carries, which is what lets the responder open the file
		// the media server has just written and what lets an operator find it when filing fails.
		const h = harness({ greetings: "accepts" });
		await h.walker.walk(walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }));

		const filed = h.filed[0];
		expect(filed?.organizationId).toBe(ORG_ID);
		expect(filed?.callId).toBe(CALL_ID);
		// `<orgId>/<callId>/<recordingId>.<format>`: the layout `mediaStartRecordingResponse.objectKey`
		// defines and the one the API's recordings root is mounted against.
		expect(filed?.objectKey).toBe(`${ORG_ID}/${CALL_ID}/${filed?.recordingId ?? ""}.wav`);
		// A minted id per greeting, so a retried request files one row rather than two racing for the
		// single active slot — and distinct from the recording's, which names the audio and not the row.
		expect(filed?.greetingId).not.toBe(filed?.recordingId);
	});

	it("does not confirm a greeting the responder REFUSED, only one it filed", async () => {
		// The end-to-end shape of the wired path: `VoicemailGreetingRpcPort` turns `applied: false`
		// into a throw carrying the responder's reason, so a refusal and an unreachable broker reach
		// the walk identically — and both play the announcement rather than the confirmation.
		const refusing = harness({ greetings: "throws" });
		const refused = await refusing.walker.walk(
			walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }),
		);
		expect(played(refusing.verbs)).toEqual([UNAVAILABLE]);

		const accepting = harness({ greetings: "accepts" });
		const accepted = await accepting.walker.walk(
			walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }),
		);
		expect(played(accepting.verbs)).toEqual([
			DEFAULT_PLAN_WALKER_SETTINGS.greetingRecordedAnnouncement,
		]);
		expect(refused.hangupCause).not.toBe(accepted.hangupCause);
	});

	it("publishes the recording pair, so the object has a lifecycle like any other", async () => {
		const h = harness({ greetings: "accepts" });
		await h.walker.walk(walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }));

		expect(h.published.map((event) => event.type)).toEqual([
			"channel.record.started",
			"channel.record.stopped",
		]);
	});

	it("records NOTHING when there is nowhere to file the result", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }),
		);

		// The order is the design: a code that recorded first would leave the user believing their
		// greeting is live, discovered later by a caller who hears the default announcement.
		expect(h.media.methods()).not.toContain("record");
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
	});

	it("discards an empty recording rather than filing silence as a greeting", async () => {
		const h = harness({
			greetings: "accepts",
			recording: { kind: "finished", durationMs: 0 },
		});
		const outcome = await h.walker.walk(
			walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }),
		);

		expect(h.filed).toEqual([]);
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.notes.join(" ")).toContain("produced no audio");
	});

	it("announces, and never confirms, when the greeting could not be filed", async () => {
		const h = harness({ greetings: "throws" });
		const outcome = await h.walker.walk(
			walkInput(greetingPlan(), { mailboxes: { [CALLER]: MAILBOX } }),
		);

		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(outcome.notes.join(" ")).toContain("could NOT be filed");
		// The note names the object, and that is the point of it: the audio exists on the shared
		// volume under this key, so a greeting the responder could not file is one an operator can
		// still recover by hand.
		expect(outcome.notes.join(" ")).toContain(`${ORG_ID}/${CALL_ID}/`);
	});

	it("refuses a caller with no mailbox of their own", async () => {
		const h = harness({ greetings: "accepts" });
		const outcome = await h.walker.walk(walkInput(greetingPlan(), { mailboxes: {} }));

		expect(h.media.methods()).not.toContain("record");
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
	});
});

// =================================================================================================
// `*97` / `*98` from the CATALOGUE
// =================================================================================================

describe("voicemail reached from the star-code catalogue", () => {
	it("opens the CALLING extension's mailbox for *97", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(
				[
					featureCodeNode("f", { action: "voicemail-check", code: "*97" }),
					voicemailNode("check", { mode: "check", mailboxNumber: CALLER }),
				],
				{ mailboxes: { [CALLER]: MAILBOX } },
			),
		);

		// The gap this closes: the compiler gives a `voicemail-check` code no `targetNodeId`, so before
		// this the only way to reach a mailbox was `settings.voicemailCheckPrefix` and a tenant on the
		// default catalogue got "not available" from a code their admin UI listed.
		expect(outcome.visited).toEqual(["f", "check"]);
	});

	it("leaves a message in the mailbox *98 names as its argument", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput(
				[
					featureCodeNode("f", { action: "voicemail-direct", code: "*98" }),
					voicemailNode("leave", { mailboxNumber: "2002" }),
				],
				{
					featureArgument: "2002",
					mailboxes: {
						"2002": {
							voicemailBoxId: "vm-2002",
							mailboxNumber: "2002",
							leaveNodeId: "leave",
							checkNodeId: "check",
						},
					},
				},
			),
		);

		expect(outcome.visited).toEqual(["f", "leave"]);
	});

	it("refuses *98 with no mailbox after it", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "voicemail-direct", code: "*98" })]),
		);

		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(outcome.notes.join(" ")).toContain("needs the mailbox");
	});

	it("announces a *97 whose caller has no box, rather than opening somebody else's", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "voicemail-check", code: "*97" })], {
				mailboxes: {
					"2002": {
						voicemailBoxId: "vm-2002",
						mailboxNumber: "2002",
						leaveNodeId: "leave",
						checkNodeId: "check",
					},
				},
			}),
		);

		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(outcome.notes.join(" ")).toContain("found no mailbox for 1001");
	});
});

// =================================================================================================
// `*0` — supervision
// =================================================================================================

/**
 * The gate, and the fact that the announcement never tells you which side of it you were on.
 *
 * The assertion that carries the security property is a NEGATIVE one, and it is easy to write a
 * suite that misses it: what matters is not that a denial announces, but that a denial announces the
 * SAME THING as "nobody is on a call". A `*0` whose two outcomes sounded different would be an
 * oracle — a handset with no grant could learn, from what it heard, whether extension 1001 is on the
 * phone right now, which is precisely the fact supervision controls access to.
 */
describe("*0 — the supervision gate", () => {
	const supervise = featureCodeNode("f", { action: "eavesdrop", code: "*0" });

	it("DENIES when the walk has no supervision port, and never falls back to allowing", async () => {
		// The one port in this file whose absence is not a degradation. Every other missing port means
		// "the feature cannot run"; this one means "the engine cannot establish that it may".
		const h = harness({ monitor: { ok: true } });
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		expect(h.monitors).toEqual([]);
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("FACILITY_NOT_SUBSCRIBED");
		expect(outcome.notes.join(" ")).toContain("DENIED");
	});

	it("asks the gate BEFORE anything about the target is looked up", async () => {
		const h = harness({ authorize: true, monitor: { ok: true } });
		await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		expect(h.authorized).toEqual([
			{
				organizationId: ORG_ID,
				extensionNumber: CALLER,
				targetExtension: "2002",
				callId: CALL_ID,
			},
		]);
	});

	it("plays the SAME announcement for a denial as for a target who is not on a call", async () => {
		const denied = harness({ authorize: false, monitor: { ok: true } });
		await denied.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		const idle = harness({
			authorize: true,
			monitor: { ok: false, reason: "nobody at extension 2002 is on a call" },
		});
		await idle.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		// Identical to the ear. The difference lives in the notes and the responder's log, where the
		// person who is allowed to know can find it.
		expect(played(denied.verbs)).toEqual(played(idle.verbs));
		expect(played(denied.verbs)).toEqual([UNAVAILABLE]);
		// And a denial never reaches the runtime at all, which is the other half of the same property.
		expect(denied.monitors).toEqual([]);
	});

	it("treats an unreachable authorization service as a denial", async () => {
		const h = harness({ authorize: "throws", monitor: { ok: true } });
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		expect(h.monitors).toEqual([]);
		expect(outcome.hangupCause).toBe("FACILITY_NOT_SUBSCRIBED");
		expect(outcome.notes.join(" ")).toContain("did not answer");
	});

	it("refuses with no extension after the code, without asking the gate", async () => {
		const h = harness({ authorize: true, monitor: { ok: true } });
		const outcome = await h.walker.walk(walkInput([supervise]));

		expect(h.authorized).toEqual([]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
	});

	it("refuses a *0 dialled against the caller's OWN extension", async () => {
		// A tap on your own leg bridged to your own leg is a feedback loop the media plane would
		// happily build.
		const h = harness({ authorize: true, monitor: { ok: true } });
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: CALLER }));

		expect(h.authorized).toEqual([]);
		expect(h.monitors).toEqual([]);
		expect(outcome.notes.join(" ")).toContain("caller's own extension");
	});

	it("refuses a caller with no number, because there is nobody to authorize", async () => {
		const h = harness({ callerNumber: null, authorize: true, monitor: { ok: true } });
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		expect(h.authorized).toEqual([]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
	});

	it("starts SILENT when it is allowed, and ends the walk with the leg up", async () => {
		const h = harness({ authorize: true, monitor: { ok: true } });
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		// `eavesdrop` and nothing else. A supervisor who dialled in must never be audible before they
		// have decided to be; whisper and barge are reached with the mode keys.
		expect(h.monitors).toEqual([{ extension: "2002", mode: "eavesdrop" }]);
		expect(outcome.status).toBe("bridged");
		// Nothing is played at a supervisor who got what they asked for: the next thing they should
		// hear is the conversation.
		expect(played(h.verbs)).toEqual([]);
	});

	it("announces when the gate allows but the runtime cannot tap", async () => {
		const h = harness({
			authorize: true,
			monitor: { ok: false, reason: "this media plane bridges in proxy-media mode" },
		});
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.notes.join(" ")).toContain("proxy-media");
	});

	it("refuses when the gate allows but the walk has no call-control runtime", async () => {
		const h = harness({ authorize: true });
		const outcome = await h.walker.walk(walkInput([supervise], { featureArgument: "2002" }));

		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
	});
});

// =================================================================================================
// `*80` — intercom
// =================================================================================================

/**
 * The auto-answer headers are the assertion, because they are the entire feature.
 *
 * An intercom without them is an ordinary call to the same extension: it rings, somebody picks it
 * up, and nobody notices anything is wrong until they are asked why the warehouse phone does not
 * open by itself. So the specs check the ORIGINATE's variables, which is where a header goes on this
 * media plane, rather than checking that a bridge happened.
 */
describe("*80 — intercom", () => {
	const intercom = featureCodeNode("f", { action: "intercom", code: "*80" });

	it("originates to the extension with BOTH auto-answer headers and bridges", async () => {
		const h = harness({ control: true });
		const outcome = await h.walker.walk(
			walkInput([intercom, extensionNode("ext", { number: "2002" })], {
				featureArgument: "2002",
			}),
		);

		expect(outcome.status).toBe("bridged");
		const originated = h.media.originated();
		expect(originated).toHaveLength(1);
		expect(originated[0]?.endpoint).toBe("PJSIP/2002");
		// Both, always: three of the five vendor templates match `Alert-Info` and Grandstream matches
		// `Call-Info`, so either header alone leaves a fleet half-deaf. See `auto-answer.ts`.
		expect(originated[0]?.variables?.["PJSIP_HEADER(add,Alert-Info)"]).toBe(
			"info=alert-autoanswer",
		);
		expect(originated[0]?.variables?.["PJSIP_HEADER(add,Call-Info)"]).toBe(
			"<sip:localhost>;answer-after=0",
		);
	});

	it("refuses with no extension after the code", async () => {
		const h = harness({ control: true });
		const outcome = await h.walker.walk(walkInput([intercom]));

		expect(h.media.originated()).toEqual([]);
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
	});

	it("refuses an extension this organization's plan does not contain", async () => {
		// Unknown and disabled are one answer: the compiler leaves a disabled extension out of the
		// artifact entirely, so "no node" is the only signal the walk gets.
		const h = harness({ control: true });
		const outcome = await h.walker.walk(
			walkInput([intercom, extensionNode("ext", { number: "2002" })], {
				featureArgument: "3003",
			}),
		);

		expect(h.media.originated()).toEqual([]);
		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(outcome.notes.join(" ")).toContain("no extension 3003");
	});

	it("announces when the handset never auto-answers, and does NOT take its voicemail branch", async () => {
		// A handset that did not auto-answer has not "failed to answer a call": the caller asked to
		// speak into a room and the room did not open. Recording a message nobody asked to leave would
		// be the wrong feature.
		const h = harness({ control: true, silentOriginate: true });
		const outcome = await h.walker.walk(
			walkInput(
				[
					intercom,
					extensionNode("ext", { number: "2002", noAnswerNodeId: "vm" }),
					voicemailNode("vm", { mailboxNumber: "2002" }),
				],
				{ featureArgument: "2002" },
			),
		);

		expect(outcome.visited).toEqual(["f"]);
		expect(outcome.hangupCause).toBe("NO_ANSWER");
		expect(played(h.verbs)).toEqual([UNAVAILABLE]);
	});
});
