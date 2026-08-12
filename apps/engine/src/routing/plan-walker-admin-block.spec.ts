import { describe, expect, it } from "bun:test";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	MIN_SALT_BYTES,
} from "@optimiq-voice/routing";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { hangupNode, planOf, trunkDialNode } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { PinAuthorization, WalkerChannel, WalkInput } from "./plan-walker";
import type {
	CompiledPinSet,
	DialByNamePlanNode,
	PlanNode,
	StreamPlanNode,
} from "@optimiq-voice/routing";
import type { DtmfCollection, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * The T2 admin block's three runtimes: dial-by-name, audio streams, and the outbound PIN gate.
 *
 * All three were compiled into the artifact by an earlier wave and executed by nothing. Two of them
 * — `stream` and `dial-by-name` — had no `case` in the walker's dispatch at all and fell into the
 * unimplemented arm, which announces "unavailable" and hangs up; the third was a `pinSet` field the
 * walker never read, which is a toll-fraud gate that renders in a form and gates nothing.
 *
 * What these specs pin is therefore mostly about REFUSALS, because that is where each of the three
 * can be wrong in a way nobody notices:
 *
 * 1. A PIN gate that fails OPEN is a spending control that is not one. It has to refuse a wrong
 *    code, an unreadable digest, and an exhausted budget — which is the opposite of what the
 *    compiler does with the same data, and the two are refusing different things.
 * 2. A stream whose source cannot be played must take the tenant's own fallback branch, not
 *    announce. `StreamPlanNode.fallbackNodeId` is non-optional precisely so this is possible, and
 *    the old behaviour discarded it.
 * 3. A directory must never offer a name it cannot speak. This platform has no text-to-speech, so
 *    "for, press one" is the failure mode, and it is silent.
 *
 * The KDF is exercised for real rather than stubbed, on the same terms `plan-walker.spec.ts` states:
 * a spec that asserted a PIN check against a fixture digest would be asserting string equality.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";
const NOW = new Date("2026-08-12T12:00:00.000Z");

interface HarnessOptions {
	/** Collections the fake `gather` returns, in order. The last entry repeats once exhausted. */
	readonly gathers?: readonly DtmfCollection[];
	readonly answered?: boolean;
}

/**
 * Every originated leg is unreachable, and that is deliberate for this file.
 *
 * None of these specs is about what happens once a carrier accepts a call — that is
 * `plan-walker.spec.ts`'s subject. What they are about is whether the call is OFFERED at all, and
 * making every INVITE fail means "the gate let it through" is assertable as "a `ringing` verb was
 * issued" without a spec having to script an answer it does not care about.
 */

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const media = makeFakeMediaPort({ originateFails: () => new Error("endpoint has no contact") });
	const verbs: Verb[] = [];
	const authorizations: PinAuthorization[] = [];
	const gathers = [...(options.gathers ?? [])];
	const state = { answered: options.answered ?? false, tearingDown: false };

	const channel: WalkerChannel = {
		mediaChannelId: A_CHANNEL,
		channelId: A_LEG_ID,
		callId: CALL_ID,
		organizationId: ORG_ID,
		callerIdNumber: "+15551234567",
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
			// The last scripted collection repeats, so a spec about "three wrong codes" scripts one.
			const collection = gathers.length > 1 ? gathers.shift() : gathers[0];
			return {
				verb: "gather",
				endReason: "completed",
				collection: collection ?? { digits: [], endReason: "timeout" },
				elapsedMs: 1,
			};
		}
		return { verb: verb.verb as never, endReason: "completed" };
	};

	const walker = new PlanWalker({
		media,
		signals,
		channel,
		execute,
		publish: async () => undefined,
		settings: { answerTimeoutMs: 200 },
		onPinAuthorization: async (authorization) => {
			authorizations.push(authorization);
		},
		newId: () => "bridge-1",
	});

	return { walker, verbs, authorizations, state, signals };
}

function walkInput(nodes: readonly PlanNode[], overrides: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), now: NOW, ...overrides };
}

function verbNames(verbs: readonly Verb[]): string[] {
	return verbs.map((verb) => verb.verb);
}

function played(verbs: readonly Verb[]): string[] {
	return verbs
		.filter((verb): verb is Extract<Verb, { verb: "play" }> => verb.verb === "play")
		.map((verb) => verb.media);
}

/** Hashed with the contract's own parameters — see this file's header. */
async function digestFor(pin: string): Promise<string> {
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
}

async function aPinSet(overrides: Partial<CompiledPinSet> = {}): Promise<CompiledPinSet> {
	return {
		pinSetId: "pin-1",
		name: "International calling",
		maxAttempts: 3,
		digitTimeoutMs: 8000,
		entries: [
			{
				pinSetEntryId: "entry-1",
				ordinal: 1,
				label: "Night desk",
				pinHash: await digestFor("4242"),
			},
		],
		...overrides,
	};
}

// =================================================================================================
// The outbound authorisation-code gate
// =================================================================================================

describe("outbound PIN sets", () => {
	const gatedPlan = (pinSet: CompiledPinSet): PlanNode[] => [
		trunkDialNode("out", { pinSet, failoverNodeId: "failover" }),
		hangupNode("failover", "NO_ANSWER"),
	];

	const input = (nodes: readonly PlanNode[]): WalkInput =>
		walkInput(nodes, { dialedNumber: "+595991234567" });

	/**
	 * The gate runs before `ringing` and before the first INVITE. Both halves matter: a code
	 * collected after the carrier has been offered the call is collected too late to stop it, and a
	 * caller who hears ringback and is then asked for a code has been told the call is going through.
	 */
	it("challenges before the carrier is offered anything, and dials on the right code", async () => {
		const h = harness({ gathers: [{ digits: ["4", "2", "4", "2"], endReason: "terminator" }] });
		await h.walker.walk(input(gatedPlan(await aPinSet())));

		const names = verbNames(h.verbs);
		expect(names.slice(0, 3)).toEqual(["answer", "gather", "ringing"]);
		expect(names.indexOf("gather")).toBeLessThan(names.indexOf("ringing"));
	});

	/** The ordinal and the label reach the CDR hook. The digits reach nothing. */
	it("reports which code authorised the call, and never the code", async () => {
		const h = harness({ gathers: [{ digits: ["4", "2", "4", "2"], endReason: "terminator" }] });
		await h.walker.walk(input(gatedPlan(await aPinSet())));

		expect(h.authorizations).toEqual([
			{ pinSetId: "pin-1", pinSetEntryId: "entry-1", ordinal: 1, label: "Night desk" },
		]);
		expect(JSON.stringify(h.authorizations)).not.toContain("4242");
	});

	/**
	 * `CALL_REJECTED`, not `NORMAL_CLEARING`. A report that cannot tell a refused authorisation from
	 * a caller who changed their mind cannot answer "is somebody guessing our codes?".
	 */
	it("refuses the call after the set's own attempt budget, and never dials", async () => {
		const h = harness({ gathers: [{ digits: ["9", "9", "9", "9"], endReason: "terminator" }] });
		const outcome = await h.walker.walk(input(gatedPlan(await aPinSet())));

		expect(outcome.status).toBe("hangup");
		expect(outcome.hangupCause).toBe("CALL_REJECTED");
		expect(verbNames(h.verbs).filter((name) => name === "gather")).toHaveLength(3);
		expect(verbNames(h.verbs)).not.toContain("ringing");
		expect(h.authorizations).toEqual([]);
	});

	/** The budget is the TENANT's, off the set, not a platform constant. */
	it("honours the set's own attempt count rather than a platform default", async () => {
		const h = harness({ gathers: [{ digits: ["9", "9", "9", "9"], endReason: "terminator" }] });
		await h.walker.walk(input(gatedPlan(await aPinSet({ maxAttempts: 1 }))));

		expect(verbNames(h.verbs).filter((name) => name === "gather")).toHaveLength(1);
	});

	/** Any code in the set opens the route, and the CDR names the one that did. */
	it("accepts any code in the set and attributes the right ordinal", async () => {
		const set = await aPinSet({
			entries: [
				{ pinSetEntryId: "e1", ordinal: 1, label: "Night desk", pinHash: await digestFor("1111") },
				{ pinSetEntryId: "e2", ordinal: 2, label: "Sales", pinHash: await digestFor("2222") },
			],
		});
		const h = harness({ gathers: [{ digits: ["2", "2", "2", "2"], endReason: "terminator" }] });
		await h.walker.walk(input(gatedPlan(set)));

		expect(h.authorizations[0]?.ordinal).toBe(2);
		expect(h.authorizations[0]?.label).toBe("Sales");
	});

	/**
	 * Fails CLOSED, which is the opposite of what `compilePinSet` does with the same data — and the
	 * two are not in conflict. The compiler fails open because taking a tenant's phones down to
	 * protect a gate they can re-create in a form is worse; but once a gate HAS been compiled, the
	 * artifact is asserting the route is gated, and waving a caller through on a digest we cannot
	 * read would make the gate decorative.
	 */
	it("fails closed on a digest it cannot verify, without burning the caller's attempts", async () => {
		const set = await aPinSet({
			entries: [{ pinSetEntryId: "e1", ordinal: 1, pinHash: "not-a-digest" }],
		});
		const h = harness({ gathers: [{ digits: ["4", "2", "4", "2"], endReason: "terminator" }] });
		const outcome = await h.walker.walk(input(gatedPlan(set)));

		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		expect(verbNames(h.verbs).filter((name) => name === "gather")).toHaveLength(1);
		expect(outcome.notes.join(" ")).toContain("cannot verify");
	});

	/** A route with no set dials exactly as it always did — no gather, no answer, no extra verb. */
	it("leaves an ungated route completely untouched", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([trunkDialNode("out", { failoverNodeId: "f" }), hangupNode("f", "NO_ANSWER")], {
				dialedNumber: "+15551230000",
			}),
		);

		expect(verbNames(h.verbs)).not.toContain("gather");
		expect(verbNames(h.verbs)[0]).toBe("ringing");
	});
});

// =================================================================================================
// Audio streams
// =================================================================================================

describe("audio stream nodes", () => {
	const streamNode = (overrides: Partial<StreamPlanNode> = {}): StreamPlanNode => ({
		id: "s",
		kind: "stream",
		audioStreamId: "stream-1",
		url: "https://media.example.com/radio.mp3",
		answerFirst: true,
		maxSeconds: 0,
		fallbackNodeId: "fallback",
		...overrides,
	});

	/**
	 * The behaviour this node kind was designed for and did not have. Before there was a case for
	 * it the walk fell into the unimplemented arm, announced "unavailable" and HUNG UP — discarding
	 * a fallback branch the tenant configured, on a node whose `fallbackNodeId` is non-optional
	 * precisely so that could not happen.
	 */
	it("takes the tenant's fallback rather than announcing, when the source cannot be played", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([streamNode(), hangupNode("fallback", "NORMAL_CLEARING")]),
		);

		expect(outcome.visited).toEqual(["s", "fallback"]);
		expect(outcome.hangupCause).toBe("NORMAL_CLEARING");
		expect(played(h.verbs)).not.toContain("sound:unavailable");
	});

	/**
	 * The note is the only place an operator will learn WHY, so it has to be a sentence rather than
	 * "resolution failed". Both drivers were checked — see `resolveMediaRefOrExplain`.
	 */
	it("says in the notes why no media server on this platform can open a remote source", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([streamNode(), hangupNode("fallback", "NORMAL_CLEARING")]),
		);

		const notes = outcome.notes.join(" ");
		expect(notes).toContain("stream-1");
		expect(notes).toContain("remote source");
	});

	/**
	 * Not answered on the way to a fallback. Answering and then discovering we cannot play would
	 * bill the tenant for a connected call that produced nothing but a branch.
	 */
	it("does not answer the leg to reach a fallback it was always going to take", async () => {
		const h = harness();
		await h.walker.walk(walkInput([streamNode(), hangupNode("fallback", "NORMAL_CLEARING")]));

		expect(verbNames(h.verbs)).not.toContain("answer");
	});

	/** A `sound:` source is playable on both drivers today, so it plays and then falls through. */
	it("plays a source the media server can open, and still continues to the fallback", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				streamNode({ url: "file:///var/lib/optimiq/hold.wav" }),
				hangupNode("fallback", "NORMAL_CLEARING"),
			]),
		);

		expect(played(h.verbs)).toContain("sound:/var/lib/optimiq/hold");
		expect(outcome.visited).toEqual(["s", "fallback"]);
	});
});

// =================================================================================================
// Dial by name
// =================================================================================================

describe("dial-by-name directories", () => {
	const entry = (digits: string, extensionNumber: string, targetNodeId: string) => ({
		digits,
		extensionNumber,
		targetNodeId,
		nameMedia: `prompt://name-${extensionNumber}`,
	});

	const directory = (overrides: Partial<DialByNamePlanNode> = {}): DialByNamePlanNode => ({
		id: "d",
		kind: "dial-by-name",
		directoryId: "dir-1",
		minDigits: 3,
		maxFailures: 2,
		entries: [entry("764", "1001", "smith"), entry("7642", "1002", "smithers")],
		timeoutNodeId: "timeout",
		...overrides,
	});

	const plan = (node: DialByNamePlanNode): PlanNode[] => [
		node,
		hangupNode("smith", "NORMAL_CLEARING"),
		hangupNode("smithers", "USER_BUSY"),
		hangupNode("timeout", "NO_USER_RESPONSE"),
	];

	/** Answer, gather the spelling, read the match, take the accept digit, go to the extension. */
	it("answers, matches a prefix, and connects the caller to the person they picked", async () => {
		const h = harness({
			gathers: [
				{ digits: ["7", "6", "4"], endReason: "terminator" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		const outcome = await h.walker.walk(walkInput(plan(directory())));

		expect(outcome.visited).toEqual(["d", "smith"]);
		expect(verbNames(h.verbs)[0]).toBe("answer");
		expect(played(h.verbs)).toContain("sound:name-1001");
	});

	/**
	 * The sentence is assembled the way `app_directory` assembles it, and the digit is GENERATED
	 * rather than recorded — which is what makes the accept digit configurable without re-recording
	 * anything.
	 */
	it("reads the name, then 'please press', then the digit, and gathers over the last fragment", async () => {
		const h = harness({
			gathers: [
				{ digits: ["7", "6", "4"], endReason: "terminator" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		await h.walker.walk(walkInput(plan(directory())));

		expect(played(h.verbs)).toEqual(["sound:name-1001", "sound:dir-multi1", "digits:1"]);
		const select = h.verbs.filter((verb) => verb.verb === "gather").at(-1);
		expect(select).toMatchObject({ verb: "gather", media: "sound:dir-multi2", maxDigits: 1 });
	});

	/** Declining the first match offers the next one rather than starting over. */
	it("moves to the next match when the caller does not take the first", async () => {
		const h = harness({
			gathers: [
				{ digits: ["7", "6", "4"], endReason: "terminator" },
				{ digits: ["2"], endReason: "max-digits" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		const outcome = await h.walker.walk(walkInput(plan(directory())));

		expect(played(h.verbs)).toContain("sound:name-1002");
		expect(outcome.visited).toEqual(["d", "smithers"]);
	});

	/** Too few digits cannot narrow a directory, and is the same failure as no digits at all. */
	it("treats a spelling shorter than minDigits as a failed round", async () => {
		const h = harness({ gathers: [{ digits: ["7"], endReason: "terminator" }] });
		const outcome = await h.walker.walk(walkInput(plan(directory())));

		expect(outcome.visited).toEqual(["d", "timeout"]);
		expect(played(h.verbs)).toContain("sound:dir-nomatch");
	});

	/** Out of attempts takes the tenant's branch, and says so rather than reading as a hangup. */
	it("takes the timeout branch when the attempts run out", async () => {
		const h = harness({ gathers: [{ digits: ["9", "9", "9"], endReason: "terminator" }] });
		const outcome = await h.walker.walk(walkInput(plan(directory())));

		expect(outcome.visited).toEqual(["d", "timeout"]);
		expect(outcome.notes.join(" ")).toContain("dir-1");
	});

	/**
	 * The one refusal this feature exists to make. There is no text-to-speech on this platform, so
	 * an entry whose recorded name will not render must be SKIPPED — offering it produces "for,
	 * press one", which is silence where a person's name should be.
	 */
	it("skips an entry whose recorded name this deployment cannot render, and names it", async () => {
		const h = harness({
			gathers: [
				{ digits: ["7", "6", "4"], endReason: "terminator" },
				{ digits: ["1"], endReason: "max-digits" },
			],
		});
		const unrenderable = {
			...entry("764", "1001", "smith"),
			// `object://` with no mount configured, which is the real deployment shape of this.
			nameMedia: "object://recorded/1001.wav",
		};
		const outcome = await h.walker.walk(
			walkInput(plan(directory({ entries: [unrenderable, entry("7642", "1002", "smithers")] }))),
		);

		expect(played(h.verbs)).not.toContain("object://recorded/1001.wav");
		expect(outcome.notes.join(" ")).toContain("1001");
		// The second entry is still offered — one unrenderable name must not take the directory down.
		expect(played(h.verbs)).toContain("sound:name-1002");
	});

	/**
	 * A directory whose every member lost their recorded name announces instead of asking. Making
	 * somebody spell a name that can match nobody is a worse minute than being told there is nobody.
	 */
	it("announces rather than gathering when there is nobody it could offer", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput(plan(directory({ entries: [] }))));

		expect(verbNames(h.verbs)).toEqual(["answer", "play", "hangup"]);
		expect(outcome.hangupCause).toBe("NO_ROUTE_DESTINATION");
	});
});
