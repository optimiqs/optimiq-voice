import { describe, expect, it } from "bun:test";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	MIN_SALT_BYTES,
} from "@optimiq-voice/routing";
import { makeFakeMediaPort } from "../ari/media-port.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { ConferenceRegistry } from "./conference-registry";
import { conferenceNode, planOf } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { WalkerChannel } from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { ConferencePlanNode } from "@optimiq-voice/routing";
import type { ChannelState, DtmfCollection, Verb, VerbResult } from "@optimiq-voice/telephony";

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

	let counter = 0;
	const walker = new PlanWalker({
		media,
		signals: options.signals,
		channel,
		execute,
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
function conference() {
	const registry = new ConferenceRegistry();
	const signals = new CallSignalBus();
	let seq = 0;
	return {
		registry,
		signals,
		caller: (gathers?: readonly string[]) => {
			seq += 1;
			return caller({
				mediaChannelId: `1754400000.${String(seq)}`,
				legId: `0195c0f0-1c2f-7000-8000-00000000000${String(seq)}`,
				registry,
				signals,
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

	it("says out loud that a room configured to record is not being recorded", async () => {
		const c = conference();
		const a = c.caller();
		const outcome = await a.walker.walk(room(conferenceNode("conf", { recordEnabled: true })));
		expect(outcome.notes.join(" ")).toContain("does not implement");
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
		await Promise.resolve();
		await Promise.resolve();

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
