import { describe, expect, it } from "bun:test";
import { isHangupCause } from "./hangup-causes";
import {
	DIAL_STRATEGIES,
	isProgressVerb,
	isTerminalVerb,
	isVerbName,
	MEDIA_PATH_VERBS,
	PROGRESS_SIP_CODES,
	PROGRESS_VERBS,
	TERMINAL_VERBS,
	TRANSFER_KINDS,
	VERB_NAMES,
	verbRequiresMediaPath,
	type DialVerb,
	type GatherVerb,
	type TransferVerb,
	type Verb,
	type VerbName,
	type VerbOf,
} from "./verbs";

/**
 * The verb union is the contract three independent consumers speak (feature runtimes, Autopilot,
 * customer voice apps). Its shape is pinned against `plans/optimiq-voice-master-plan.md` §4.2 and
 * `plans/reference/freeswitch-capabilities.md` §1-§5.
 */
describe("verb catalogue", () => {
	it("lists every verb exactly once", () => {
		expect(new Set(VERB_NAMES).size).toBe(VERB_NAMES.length);
	});

	// The master-plan §4.2 list is the floor, not the ceiling — these must always be present.
	it.each([
		"answer",
		"ringing",
		"earlyMedia",
		"play",
		"say",
		"gather",
		"record",
		"dial",
		"bridge",
		"transfer",
		"hold",
		"unhold",
		"park",
		"playDtmf",
		"hangup",
	] as const)("includes the master-plan verb %s", (verb) => {
		expect(VERB_NAMES).toContain(verb);
	});

	it("guards verb names arriving on the session stream", () => {
		expect(isVerbName("earlyMedia")).toBe(true);
		expect(isVerbName("early_media")).toBe(false);
		expect(isVerbName("originate")).toBe(false);
	});

	it("keeps every classification list inside the catalogue", () => {
		for (const verb of [...MEDIA_PATH_VERBS, ...TERMINAL_VERBS, ...PROGRESS_VERBS]) {
			expect(isVerbName(verb)).toBe(true);
		}
	});
});

/**
 * Answer semantics (reference §1): 180 is alerting with no media, 183 opens audio BEFORE billing,
 * 200 starts the billing clock. Implicitly answering to satisfy a play verb bills a caller for a
 * call they never got, so media verbs are flagged rather than auto-answered.
 */
describe("answer and progress semantics", () => {
	it("maps the progress verbs to their SIP codes", () => {
		expect(PROGRESS_SIP_CODES.ringing).toBe(180);
		expect(PROGRESS_SIP_CODES.earlyMedia).toBe(183);
		expect(PROGRESS_SIP_CODES.answer).toBe(200);
	});

	it("classifies exactly the three progress verbs", () => {
		expect(VERB_NAMES.filter(isProgressVerb).sort()).toEqual(["answer", "earlyMedia", "ringing"]);
		expect(Object.keys(PROGRESS_SIP_CODES).sort()).toEqual([...PROGRESS_VERBS].sort());
	});

	it("requires a media path for every verb that moves audio", () => {
		for (const verb of ["play", "say", "gather", "record", "playDtmf"] as const) {
			expect(verbRequiresMediaPath(verb)).toBe(true);
		}
	});

	it("never requires a media path for a progress or control verb", () => {
		for (const verb of ["answer", "ringing", "earlyMedia", "dial", "hangup", "sleep"] as const) {
			expect(verbRequiresMediaPath(verb)).toBe(false);
		}
	});

	// A blind transfer re-routes the leg into another context: it lives on, but not for this app.
	it("treats hangup and transfer as ending application control", () => {
		expect(VERB_NAMES.filter(isTerminalVerb).sort()).toEqual(["hangup", "transfer"]);
		expect(TERMINAL_VERBS).toContain("transfer");
	});

	it("keeps the terminal and media-path sets disjoint", () => {
		for (const verb of TERMINAL_VERBS) {
			expect(verbRequiresMediaPath(verb)).toBe(false);
		}
	});
});

describe("dial semantics", () => {
	it("offers ring-all and failover strategies", () => {
		expect(DIAL_STRATEGIES).toEqual(["simultaneous", "sequential"]);
	});

	// Losers of a ring-all race must be hung up with LOSE_RACE (reference §2).
	it("expresses a ring-group dial with confirmation and a failover cause list", () => {
		const verb: DialVerb = {
			verb: "dial",
			strategy: "simultaneous",
			timeoutMs: 30_000,
			callerId: { name: "Support", number: "+15550000000" },
			continueOnCauses: ["USER_BUSY", "NO_ANSWER"],
			confirm: { media: "prompt://press-1-to-accept", key: "1", timeoutMs: 5_000 },
			targets: [
				{ kind: "extension", destination: "1001" },
				{ kind: "user", destination: "alice@example.test", timeoutMs: 20_000 },
				{ kind: "external", destination: "+15551234567", trunkRef: "trunk-primary" },
			],
		};

		expect(verb.targets).toHaveLength(3);
		for (const cause of verb.continueOnCauses ?? []) {
			expect(isHangupCause(cause)).toBe(true);
		}
	});

	it("types continueOnCauses as real hangup causes", () => {
		const causes: DialVerb["continueOnCauses"] = ["NO_ANSWER", "USER_BUSY", "GATEWAY_DOWN"];
		for (const cause of causes ?? []) {
			expect(isHangupCause(cause)).toBe(true);
		}
	});
});

describe("transfer and gather payloads", () => {
	it("offers blind and attended transfers with a fallback destination", () => {
		expect(TRANSFER_KINDS).toEqual(["blind", "attended"]);

		const verb: TransferVerb = {
			verb: "transfer",
			kind: "attended",
			destination: { destination: "2001", context: "default" },
			fallbackDestination: { destination: "operator" },
			cancelKey: "*",
		};

		expect(verb.kind).toBe("attended");
		expect(verb.fallbackDestination?.destination).toBe("operator");
	});

	// Both timeouts are required: defaulting either is how an IVR hangs on a silent caller.
	it("requires both gather timeouts and a terminator list", () => {
		const verb: GatherVerb = {
			verb: "gather",
			maxDigits: 4,
			terminators: ["#"],
			timeoutMs: 5_000,
			interDigitTimeoutMs: 2_000,
			regex: "^\\d{3,4}$",
		};

		expect(verb.timeoutMs).toBeGreaterThan(verb.interDigitTimeoutMs);
		expect(verb.terminators).toEqual(["#"]);
	});
});

describe("verb union", () => {
	// The discriminant is what lets a handler be an exhaustive switch, so adding a verb is a
	// compile error everywhere it must be handled rather than a silent no-op at runtime.
	it("discriminates on the verb field and narrows each payload", () => {
		const summarise = (verb: Verb): string => {
			switch (verb.verb) {
				case "gather":
					return `gather:${verb.maxDigits}`;
				case "dial":
					return `dial:${verb.targets.length}`;
				case "hangup":
					return `hangup:${verb.cause ?? "NORMAL_CLEARING"}`;
				default:
					return verb.verb satisfies VerbName;
			}
		};

		expect(summarise({ verb: "answer" })).toBe("answer");
		expect(summarise({ verb: "hangup", cause: "USER_BUSY" })).toBe("hangup:USER_BUSY");
		expect(summarise({ verb: "hangup" })).toBe("hangup:NORMAL_CLEARING");
		expect(
			summarise({
				verb: "dial",
				strategy: "sequential",
				timeoutMs: 10_000,
				targets: [{ kind: "extension", destination: "1001" }],
			}),
		).toBe("dial:1");
		expect(
			summarise({
				verb: "gather",
				maxDigits: 1,
				terminators: [],
				timeoutMs: 1_000,
				interDigitTimeoutMs: 500,
			}),
		).toBe("gather:1");
	});

	it("narrows a single verb by name through VerbOf", () => {
		const hold: VerbOf<"hold"> = { verb: "hold", musicOnHold: "stream://moh/default" };
		expect(hold.musicOnHold).toBe("stream://moh/default");
	});
});
