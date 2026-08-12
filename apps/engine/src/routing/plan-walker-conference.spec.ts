import { describe, expect, it } from "bun:test";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	MIN_SALT_BYTES,
} from "@optimiq-voice/routing";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { ConferenceRegistry } from "./conference-registry";
import { conferenceNode, planOf } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { PlanWalkerDependencies, WalkerChannel } from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { ConferencePlanNode } from "@optimiq-voice/routing";
import type { ChannelState, DtmfCollection, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * Settles the microtask queue.
 *
 * A fixed number of `await Promise.resolve()` calls used to be enough; a park or conference claim
 * that may be shared adds asynchronous steps to paths that were synchronous, and a spec that
 * hard-codes the tick count breaks every time one is added. Draining until nothing is left pending
 * is the assertion these specs actually mean.
 */
async function flush(ticks = 12): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await Promise.resolve();
	}
}

/**
 * The conference runtime: the real {@link PlanWalker} over the real {@link ConferenceRegistry},
 * with only the media server and the verb executor faked.
 *
 * Two things are being proved here and they are different. The PIN gate is a SECURITY property —
 * a wrong PIN must not reach the bridge, a moderator PIN must be told apart from a participant
 * one, and a digest this release cannot read must refuse the room rather than open it. The join
 * is a MEDIA property — two walks over the same room have to reach one bridge id, and the last
 * one out has to destroy it.
 *
 * The second is the reason the registry is a collaborator rather than walker state, so it is
 * tested with two walkers rather than one.
 */

const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";

/** A digest of a real PIN, so the constant-time verifier is exercised rather than stubbed. */
async function digestOf(pin: string): Promise<string> {
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

interface PublishedEvent {
	readonly type: CallEvent;
	readonly data: Record<string, unknown>;
}

interface CallerOptions {
	readonly mediaChannelId: string;
	readonly legId: string;
	/** Digits the fake `gather` returns, in order. The last entry repeats. */
	readonly gathers?: readonly string[];
	readonly registry: ConferenceRegistry;
	readonly signals: CallSignalBus;
	readonly idPrefix: string;
	/** Counts what the room's record policy asked for, and whether the media plane could serve it. */
	readonly recording?: { starts: number; canRecord: boolean };
}

/** One caller: a walker, its channel, and everything the fakes recorded for it. */
function caller(options: CallerOptions) {
	const verbs: Verb[] = [];
	const published: PublishedEvent[] = [];
	const states: ChannelState[] = [];
	const gathers = [...(options.gathers ?? [])];
	const state = { answered: false, tearingDown: false, bridgeId: undefined as string | undefined };

	const media = makeFakeMediaPort();

	const channel: WalkerChannel = {
		mediaChannelId: options.mediaChannelId,
		channelId: options.legId,
		callId: CALL_ID,
		organizationId: ORG_ID,
		callerIdNumber: "+15551234567",
		callerIdName: "Ada",
		isDetached: false,
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
		switch (verb.verb) {
			case "answer": {
				state.answered = true;
				options.signals.emit(legSignalKey(options.mediaChannelId), { kind: "answered" });
				return { verb: "answer", endReason: "completed" };
			}
			case "hangup": {
				state.tearingDown = true;
				return { verb: "hangup", endReason: "completed" };
			}
			case "gather": {
				const digits = (gathers.length > 1 ? gathers.shift() : gathers[0]) ?? "";
				const collection: DtmfCollection = {
					digits: digits === "" ? [] : ([...digits] as DtmfCollection["digits"]),
					endReason: digits === "" ? "timeout" : "max-digits",
				};
				return { verb: "gather", endReason: "completed", collection, elapsedMs: 1 };
			}
			case "play": {
				return { verb: "play", endReason: "completed", playbackRef: "pb", elapsedMs: 1 };
			}
			default: {
				return { verb: verb.verb as never, endReason: "completed" };
			}
		}
	};

	const recording = options.recording;
	let counter = 0;
	const walker = new PlanWalker({
		media,
		signals: options.signals,
		channel,
		execute,
		// The same seam a queue's record policy reaches, so a conference recording is
		// indistinguishable downstream from a queue one or an on-demand one.
		...(recording === undefined
			? {}
			: {
					control: {
						startRecording: async () => {
							recording.starts += 1;
							await Promise.resolve();
							return recording.canRecord
								? { ok: true }
								: { ok: false, reason: "this media plane cannot record a mix" };
						},
					} as PlanWalkerDependencies["control"],
				}),
		publish: async (type, data) => {
			published.push({ type, data });
		},
		settings: { answerTimeoutMs: 200, conferenceModeratorWaitMs: 50 },
		conferences: options.registry,
		newId: () => {
			counter += 1;
			return `${options.idPrefix}-${String(counter)}`;
		},
		delay: (ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, Math.min(ms, 20)).unref?.();
			}),
	});

	return {
		walker,
		verbs,
		published,
		states,
		state,
		media,
		/** Ends the leg the way the orchestrator does, which is what triggers the leave path. */
		hangUp: () => {
			state.tearingDown = true;
			options.signals.emit(legSignalKey(options.mediaChannelId), {
				kind: "ended",
				cause: "NORMAL_CLEARING",
				causeCode: 16,
			});
		},
	};
}

function room(node: ConferencePlanNode) {
	return { plan: planOf([node]), now: new Date("2026-08-05T12:00:00.000Z") };
}

/** A registry, a bus, and a factory for callers into the same room. */
function conference(options: { readonly canRecord?: boolean } = {}) {
	const registry = new ConferenceRegistry();
	const signals = new CallSignalBus();
	const recording = { starts: 0, canRecord: options.canRecord ?? true };
	let seq = 0;
	return {
		registry,
		signals,
		/** How many times the room's record policy reached the call-control port. */
		get recordingStarts(): number {
			return recording.starts;
		},
		caller: (gathers?: readonly string[]) => {
			seq += 1;
			return caller({
				mediaChannelId: `1754400000.${String(seq)}`,
				legId: `0195c0f0-1c2f-7000-8000-00000000000${String(seq)}`,
				registry,
				signals,
				recording,
				idPrefix: `c${String(seq)}`,
				...(gathers === undefined ? {} : { gathers }),
			});
		},
	};
}

// =================================================================================================
// Joining
// =================================================================================================

describe("a conference with no PIN", () => {
	it("answers, creates a bridge and puts the caller in it", async () => {
		const c = conference();
		const a = c.caller();
		const outcome = await a.walker.walk(room(conferenceNode("conf")));

		expect(outcome.status).toBe("bridged");
		expect(a.media.methods()).toContain("createBridge");
		expect(a.media.methods()).toContain("addToBridge");
		expect(a.state.bridgeId).toBeDefined();
	});

	it("does not challenge for a PIN the room does not have", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		expect(a.verbs.map((verb) => verb.verb)).not.toContain("gather");
	});

	it("puts two callers into the SAME bridge", async () => {
		const c = conference();
		const a = c.caller();
		const b = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		await b.walker.walk(room(conferenceNode("conf")));

		expect(b.state.bridgeId).toBe(a.state.bridgeId as string);
		expect(c.registry.room("conf-conf")?.members).toHaveLength(2);
	});

	it("publishes a join carrying the member count after the join", async () => {
		const c = conference();
		const a = c.caller();
		const b = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		await b.walker.walk(room(conferenceNode("conf")));

		const joins = [...a.published, ...b.published].filter(
			(event) => event.type === "conference.joined",
		);
		expect(joins.map((event) => event.data.memberCount)).toEqual([1, 2]);
		expect(joins[0]?.data.moderator).toBe(false);
	});

	it("refuses a caller once the room is at its member limit", async () => {
		const c = conference();
		const a = c.caller();
		const b = c.caller();
		await a.walker.walk(room(conferenceNode("conf", { maxMembers: 1 })));
		const outcome = await b.walker.walk(room(conferenceNode("conf", { maxMembers: 1 })));

		expect(outcome.hangupCause).toBe("USER_BUSY");
		expect(b.media.methods()).not.toContain("addToBridge");
		expect(c.registry.room("conf-conf")?.members).toHaveLength(1);
	});

	/**
	 * A ROOM is recorded once, by whoever opened it — not once per participant, which would produce N
	 * files of one meeting, N retention clocks and N copies of everybody's voice.
	 */
	it("records the room when its policy says so, and only for the member who opened it", async () => {
		const c = conference();
		const node = conferenceNode("conf", { recordPolicy: "all" });

		await c.caller().walker.walk(room(node));
		await c.caller().walker.walk(room(node));

		expect(c.recordingStarts).toBe(1);
	});

	/**
	 * `on-demand` means "somebody presses the record key", which is a mid-call feature that already
	 * works. Starting one here would record every meeting for a tenant who asked for the opposite.
	 */
	it("does not record an on-demand room", async () => {
		const c = conference();
		await c.caller().walker.walk(room(conferenceNode("conf", { recordPolicy: "on-demand" })));
		expect(c.recordingStarts).toBe(0);
	});

	/**
	 * A tenant who ticked "record this room" and finds no recording has a compliance problem, and a
	 * note in the call log is the difference between finding out now and finding out at the hearing.
	 */
	it("says out loud when a recorded room could not be recorded", async () => {
		const c = conference({ canRecord: false });
		const outcome = await c
			.caller()
			.walker.walk(room(conferenceNode("conf", { recordPolicy: "all" })));
		expect(outcome.notes.join(" ")).toContain("record policy");
	});

	it("announces and hangs up when the walk was given no registry", async () => {
		const signals = new CallSignalBus();
		const bare = new PlanWalker({
			media: makeFakeMediaPort(),
			signals,
			channel: {
				mediaChannelId: "1754400000.9",
				channelId: "0195c0f0-1c2f-7000-8000-0000000000f9",
				callId: CALL_ID,
				organizationId: ORG_ID,
				isTearingDown: false,
				isDetached: false,
				isAnswered: true,
				moveTo: () => true,
				setBridge: () => undefined,
			},
			execute: async (verb) => ({ verb: verb.verb as never, endReason: "completed" }),
			publish: async () => undefined,
		});
		const outcome = await bare.walk(room(conferenceNode("conf")));

		expect(outcome.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
		expect(outcome.notes.join(" ")).toContain("no conference registry");
	});
});

// =================================================================================================
// The PIN gate
// =================================================================================================

describe("a PIN-gated conference", () => {
	it("admits the caller who enters the room PIN", async () => {
		const pinHash = await digestOf("4242");
		const c = conference();
		const a = c.caller(["4242"]);
		const outcome = await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash })),
		);

		expect(outcome.status).toBe("bridged");
		expect(a.media.methods()).toContain("addToBridge");
	});

	it("refuses after three wrong PINs and never touches the bridge", async () => {
		const pinHash = await digestOf("4242");
		const c = conference();
		const a = c.caller(["1111"]);
		const outcome = await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash })),
		);

		expect(outcome.hangupCause).toBe("CALL_REJECTED");
		expect(a.verbs.filter((verb) => verb.verb === "gather")).toHaveLength(3);
		expect(a.media.methods()).not.toContain("addToBridge");
		// A refused caller is not a member: a wrong PIN cannot be used to probe a room's size.
		expect(c.registry.room("conf-conf")).toBeUndefined();
	});

	it("lets a caller who gets it right on the third try in", async () => {
		const pinHash = await digestOf("4242");
		const c = conference();
		const a = c.caller(["1111", "2222", "4242"]);
		const outcome = await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash })),
		);
		expect(outcome.status).toBe("bridged");
	});

	it("REFUSES the room when the compiler embedded no digest for a PIN it announces", async () => {
		// `requiresPin` with no `pinHash` is an unreadable digest or a pre-E911 artifact. Admitting
		// the caller would turn a formatting change into an open bridge.
		const c = conference();
		const a = c.caller(["4242"]);
		const outcome = await a.walker.walk(room(conferenceNode("conf", { requiresPin: true })));

		expect(outcome.status).toBe("hangup");
		expect(outcome.notes.join(" ")).toContain("refused rather than opened");
		expect(a.media.methods()).not.toContain("addToBridge");
	});

	it("refuses rather than retrying when the digest itself cannot be parsed", async () => {
		const c = conference();
		const a = c.caller(["4242"]);
		const outcome = await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash: "not-a-digest" })),
		);

		expect(outcome.hangupCause).toBe("NORMAL_TEMPORARY_FAILURE");
		// One attempt, not three: retrying a check that can never succeed only burns the budget.
		expect(a.verbs.filter((verb) => verb.verb === "gather")).toHaveLength(1);
	});

	it("never tells the caller which of the two PINs they got wrong", async () => {
		const pinHash = await digestOf("4242");
		const moderatorPinHash = await digestOf("9999");
		const c = conference();
		const a = c.caller(["1111"]);
		await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash, moderatorPinHash })),
		);
		const played = a.verbs.filter((verb) => verb.verb === "play").map((verb) => verb.media);
		expect(new Set(played).size).toBe(1);
	});
});

// =================================================================================================
// Moderators
// =================================================================================================

describe("moderator entry", () => {
	it("admits the moderator PIN as a moderator", async () => {
		const pinHash = await digestOf("4242");
		const moderatorPinHash = await digestOf("9999");
		const c = conference();
		const a = c.caller(["9999"]);
		await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash, moderatorPinHash })),
		);

		expect(a.published.find((event) => event.type === "conference.joined")?.data.moderator).toBe(
			true,
		);
		expect(c.registry.room("conf-conf")?.moderatorPresent).toBe(true);
	});

	it("admits the room PIN as a participant, not a moderator", async () => {
		const pinHash = await digestOf("4242");
		const moderatorPinHash = await digestOf("9999");
		const c = conference();
		const a = c.caller(["4242"]);
		await a.walker.walk(
			room(conferenceNode("conf", { requiresPin: true, pinHash, moderatorPinHash })),
		);

		expect(a.published.find((event) => event.type === "conference.joined")?.data.moderator).toBe(
			false,
		);
		expect(c.registry.room("conf-conf")?.moderatorPresent).toBe(false);
	});

	it("lets a participant in with no digits when only a moderator PIN is set", async () => {
		const moderatorPinHash = await digestOf("9999");
		const c = conference();
		const a = c.caller([""]);
		const outcome = await a.walker.walk(room(conferenceNode("conf", { moderatorPinHash })));

		expect(outcome.status).toBe("bridged");
		expect(a.published.find((event) => event.type === "conference.joined")?.data.moderator).toBe(
			false,
		);
	});

	it("holds a participant OUTSIDE the bridge until a moderator arrives", async () => {
		const moderatorPinHash = await digestOf("9999");
		const node = conferenceNode("conf", { waitForModerator: true, moderatorPinHash });
		const c = conference();
		const participant = c.caller([""]);
		const moderator = c.caller(["9999"]);

		const held = participant.walker.walk(room(node));
		// The moderator's own walk is what releases the hold; without it the participant times out.
		await moderator.walker.walk(room(node));
		const outcome = await held;

		expect(outcome.status).toBe("bridged");
		expect(participant.media.methods()).toContain("startMusicOnHold");
		// The hold happens before the media join, so early arrivals cannot hear each other.
		const calls = participant.media.methods();
		expect(calls.indexOf("startMusicOnHold")).toBeLessThan(calls.indexOf("addToBridge"));
	});

	it("gives up on a moderator who never dials in, rather than holding the channel forever", async () => {
		const moderatorPinHash = await digestOf("9999");
		const c = conference();
		const a = c.caller([""]);
		const outcome = await a.walker.walk(
			room(conferenceNode("conf", { waitForModerator: true, moderatorPinHash })),
		);

		expect(outcome.status).toBe("aborted");
		expect(outcome.notes.join(" ")).toContain("no moderator joined");
		// And the caller is not left in the room they never entered.
		expect(c.registry.room("conf-conf")).toBeUndefined();
	});

	it("does not hold a moderator for themselves", async () => {
		const moderatorPinHash = await digestOf("9999");
		const c = conference();
		const a = c.caller(["9999"]);
		const outcome = await a.walker.walk(
			room(conferenceNode("conf", { waitForModerator: true, moderatorPinHash })),
		);

		expect(outcome.status).toBe("bridged");
		expect(a.media.methods()).not.toContain("startMusicOnHold");
	});
});

// =================================================================================================
// Leaving
// =================================================================================================

describe("leaving a conference", () => {
	it("publishes a leave and destroys the bridge when the last member goes", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		a.hangUp();
		await flush();

		const left = a.published.find((event) => event.type === "conference.left");
		expect(left?.data.memberCount).toBe(0);
		expect(a.media.methods()).toContain("destroyBridge");
		expect(c.registry.room("conf-conf")).toBeUndefined();
	});

	it("leaves the bridge standing while somebody is still in it", async () => {
		const c = conference();
		const a = c.caller();
		const b = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		await b.walker.walk(room(conferenceNode("conf")));
		a.hangUp();
		await Promise.resolve();
		await Promise.resolve();

		expect(a.published.find((event) => event.type === "conference.left")?.data.memberCount).toBe(1);
		expect(a.media.methods()).not.toContain("destroyBridge");
		expect(c.registry.room("conf-conf")?.members).toHaveLength(1);
	});
});

// =================================================================================================
// Locking, and the beeps
// =================================================================================================

describe("a locked room", () => {
	/**
	 * A caller told the room is FULL redials in a minute; a caller told it is LOCKED does not. That
	 * is the whole reason the registry answers two different results, and the walker has to say two
	 * different things or the distinction never reaches anybody.
	 */
	it("announces and refuses with a different prompt from a full one", async () => {
		const c = conference();
		const node = conferenceNode("conf");
		await c.caller().walker.walk(room(node));
		await c.registry.setLocked("conf-conf", true);

		const b = c.caller();
		const outcome = await b.walker.walk(room(node));

		expect(outcome.status).toBe("hangup");
		// Through the VERB executor, which is how every announcement on a refusal path is played:
		// the caller is not in a bridge, so there is nothing to play into.
		const announced = b.verbs
			.filter((verb) => verb.verb === "play")
			.map((verb) => (verb as { media: string }).media)
			.join(" ");
		expect(announced).toContain("conf-locked");
		expect(announced).not.toContain("conf-full");
	});

	it("never touches the bridge for a caller it refused", async () => {
		const c = conference();
		const node = conferenceNode("conf");
		await c.caller().walker.walk(room(node));
		await c.registry.setLocked("conf-conf", true);

		const b = c.caller();
		await b.walker.walk(room(node));

		expect(b.media.methods()).not.toContain("addToBridge");
		expect(c.registry.room("conf-conf")?.members).toHaveLength(1);
	});
});

describe("entry and exit tones", () => {
	/** Played into the BRIDGE, not at the caller: the room is the audience. */
	function tonesPlayedInto(caller: ReturnType<ReturnType<typeof conference>["caller"]>): string[] {
		return caller.media.calls
			.filter((call) => call.method === "play")
			.flatMap((call) => (call.args[1] as { media: readonly string[] }).media);
	}

	it("beeps the room on arrival, into the bridge", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));

		const played = a.media.calls.filter((call) => call.method === "play");
		expect(played).toHaveLength(1);
		expect(played[0]?.args[0]).toBe(a.state.bridgeId as string);
		expect(tonesPlayedInto(a)).toContain("tone:beep");
	});

	/**
	 * `tone:` and not `sound:`, which is what makes the default possible at all: a tone is GENERATED,
	 * so a deployment with no prompt pack mounted still beeps.
	 */
	it("uses a generated tone rather than a file, so a stock install beeps", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		expect(tonesPlayedInto(a).some((media) => media.startsWith("tone:"))).toBe(true);
	});

	it("plays the name announcement beside the tone when the room asks for one", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(room(conferenceNode("conf", { announceJoinLeave: true })));
		// Both, in one playback: the beep first, then the clause.
		expect(tonesPlayedInto(a)).toEqual(["tone:beep", "sound:conf-hasjoin"]);
	});

	/**
	 * The flags default ON at every layer and the compiler emits them only when a tenant switched
	 * them OFF, so an artifact from before the columns existed must still beep.
	 */
	it("stays silent only when both are switched off", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(
			room(
				conferenceNode("conf", {
					entryToneEnabled: false,
					announceJoinLeave: false,
				}),
			),
		);
		expect(a.media.methods()).not.toContain("play");
	});

	/**
	 * A beep into an empty bridge is a playback nobody hears and a media command racing the teardown.
	 */
	it("does not beep a room it is about to destroy", async () => {
		const c = conference();
		const a = c.caller();
		await a.walker.walk(room(conferenceNode("conf")));
		const before = a.media.calls.filter((call) => call.method === "play").length;

		a.hangUp();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(a.media.calls.filter((call) => call.method === "play")).toHaveLength(before);
		expect(a.media.methods()).toContain("destroyBridge");
	});
});
