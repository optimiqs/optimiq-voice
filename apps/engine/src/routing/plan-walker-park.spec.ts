import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../ari/media-port.fake";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { featureCodeNode, hangupNode, parkNode, planOf } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { WalkerCallControl, WalkerChannel, WalkInput } from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { PlanNode } from "@optimiq-voice/routing";
import type { Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * Park lots and call pickup, as the plan walker executes them.
 *
 * The call-control runtime is a port here, exactly like the media server and the verb executor, so
 * these specs are about the ONE decision the walker owns: which of a park node's two operations the
 * dialled digits mean. Everything the operations themselves do — claiming an orbit exclusively,
 * arming a timeout, hanging the ringing phone up with `PICKED_OFF` — is `call-control.spec.ts`'s
 * subject and is not re-tested through a second layer.
 */

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";

interface ControlCall {
	readonly method: "park" | "unpark" | "pickup";
	readonly args: unknown;
}

interface HarnessOptions {
	/** How the call-control runtime answers. Defaults to succeeding. */
	readonly parkResult?: { ok: boolean; slot?: number; reason?: string };
	readonly unparkResult?: { ok: boolean; reason?: string };
	readonly pickupResult?: { ok: boolean; reason?: string };
	/** Absent means the walk was built without a call-control runtime at all. */
	readonly withControl?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const media = makeFakeMediaPort();
	const verbs: Verb[] = [];
	const control: ControlCall[] = [];
	const published: { type: CallEvent }[] = [];
	const state = { answered: false, tearingDown: false };

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
		return { verb: verb.verb as never, endReason: "completed" };
	};

	const callControl: WalkerCallControl = {
		park: async (request) => {
			control.push({ method: "park", args: request });
			return options.parkResult ?? { ok: true, slot: 401 };
		},
		unpark: async (request) => {
			control.push({ method: "unpark", args: request });
			return options.unparkResult ?? { ok: true };
		},
		pickup: async (request) => {
			control.push({ method: "pickup", args: request });
			return options.pickupResult ?? { ok: true };
		},
	};

	const walker = new PlanWalker({
		media,
		signals,
		channel,
		execute,
		publish: async (type) => {
			published.push({ type });
		},
		...(options.withControl === false ? {} : { control: callControl }),
		newId: () => "bridge-1",
	});

	return { walker, control, verbs, media, published };
}

function walkInput(nodes: readonly PlanNode[], extra: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), ...extra };
}

describe("a park node with no orbit dialled", () => {
	it("parks the call and ends the walk with the leg still up", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([parkNode("p")]));

		expect(outcome.status).toBe("bridged");
		expect(h.control).toEqual([
			{ method: "park", args: { parkLotId: "lot-p", timeoutMs: 120_000 } },
		]);
		expect(outcome.notes.join(" ")).toContain("parked on orbit 401");
	});

	it("answers first — a caller in an orbit with no media path hears nothing", async () => {
		const h = harness();
		await h.walker.walk(walkInput([parkNode("p")]));
		expect(h.verbs[0]?.verb).toBe("answer");
	});

	it("carries the lot's music class and omits a timeout the lot does not have", async () => {
		const h = harness();
		await h.walker.walk(walkInput([parkNode("p", { timeoutSeconds: 0, mohClass: "jazz" })]));
		expect(h.control[0]?.args).toEqual({ parkLotId: "lot-p", mohClass: "jazz" });
	});

	it("takes the lot's timeout branch when the lot cannot accept the call", async () => {
		const h = harness({ parkResult: { ok: false, reason: "every orbit in the lot is taken" } });
		const outcome = await h.walker.walk(
			walkInput([
				parkNode("p", { timeoutNodeId: "busy" }),
				hangupNode("busy", "NORMAL_CIRCUIT_CONGESTION"),
			]),
		);

		expect(outcome.hangupCause).toBe("NORMAL_CIRCUIT_CONGESTION");
		expect(outcome.notes.join(" ")).toContain("every orbit in the lot is taken");
	});

	it("announces a full lot with USER_BUSY when it has no branch of its own", async () => {
		const h = harness({ parkResult: { ok: false, reason: "the lot is full" } });
		const outcome = await h.walker.walk(walkInput([parkNode("p")]));
		expect(outcome.hangupCause).toBe("USER_BUSY");
	});
});

describe("a park node with an orbit dialled", () => {
	it("RETRIEVES when the dialled digits are a slot in this lot's range", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([parkNode("p")], { originalDialedNumber: "402" }),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.control).toEqual([{ method: "unpark", args: { parkLotId: "lot-p", orbit: "402" } }]);
	});

	it("PARKS when the digits are outside the lot's range — a retrieval of a slot this lot does not have is not a retrieval", async () => {
		const h = harness();
		await h.walker.walk(walkInput([parkNode("p")], { originalDialedNumber: "999" }));
		expect(h.control[0]?.method).toBe("park");
	});

	it("parks into the orbit the caller asked for after the feature code", async () => {
		const h = harness();
		// `*5` dialled bare: the argument is empty, so the lot auto-assigns.
		await h.walker.walk(walkInput([parkNode("p")], { featureArgument: "" }));
		expect(h.control[0]?.args).toEqual({ parkLotId: "lot-p", timeoutMs: 120_000 });
	});

	it("prefers the feature argument over the dialled number when deciding the orbit", async () => {
		const h = harness();
		await h.walker.walk(
			walkInput([parkNode("p")], { featureArgument: "403", originalDialedNumber: "*5403" }),
		);
		expect(h.control).toEqual([{ method: "unpark", args: { parkLotId: "lot-p", orbit: "403" } }]);
	});

	it("announces NO_PICKUP when the orbit is empty rather than parking the collector", async () => {
		const h = harness({ unparkResult: { ok: false, reason: "nothing is parked on orbit 401" } });
		const outcome = await h.walker.walk(
			walkInput([parkNode("p")], { originalDialedNumber: "401" }),
		);

		expect(outcome.hangupCause).toBe("NO_PICKUP");
		expect(h.control.map((call) => call.method)).toEqual(["unpark"]);
	});
});

describe("pickup feature codes", () => {
	it("takes the call ringing at the extension the caller dialled after the code", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-pickup", code: "**" })], {
				featureArgument: "200",
			}),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.control).toEqual([{ method: "pickup", args: { kind: "directed", extension: "200" } }]);
		// NOT answered by the walk: `pickup` answers the leg at the moment it has a call to connect,
		// so a feature code that finds nothing never starts billing.
		expect(h.verbs).toEqual([]);
	});

	it("takes whatever is ringing in the group for a code with no argument", async () => {
		const h = harness();
		await h.walker.walk(walkInput([featureCodeNode("f", { action: "group-pickup", code: "*8" })]));
		expect(h.control).toEqual([{ method: "pickup", args: { kind: "group", extension: "" } }]);
	});

	it("refuses a directed pickup with no extension", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-pickup", code: "**" })]),
		);

		expect(outcome.hangupCause).toBe("INVALID_NUMBER_FORMAT");
		expect(h.control).toEqual([]);
	});

	it("says NO_PICKUP when nothing was ringing — not NO_ANSWER, which is a different fact", async () => {
		const h = harness({
			pickupResult: { ok: false, reason: "nothing is ringing at extension 200" },
		});
		const outcome = await h.walker.walk(
			walkInput([featureCodeNode("f", { action: "call-pickup", code: "**" })], {
				featureArgument: "200",
			}),
		);

		expect(outcome.hangupCause).toBe("NO_PICKUP");
		expect(outcome.notes.join(" ")).toContain("nothing is ringing at extension 200");
	});

	it("follows a feature code that compiled to a target node instead of running the feature", async () => {
		const h = harness();
		const outcome = await h.walker.walk(
			walkInput([
				featureCodeNode("f", { action: "call-park", code: "*5", targetNodeId: "p" }),
				parkNode("p"),
			]),
		);

		expect(outcome.status).toBe("bridged");
		expect(h.control[0]?.method).toBe("park");
	});
});

describe("without a call-control runtime", () => {
	it("announces and hangs up rather than pretending the feature worked", async () => {
		const h = harness({ withControl: false });
		const parked = await h.walker.walk(walkInput([parkNode("p")]));
		expect(parked.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");

		const picked = await harness({ withControl: false }).walker.walk(
			walkInput([featureCodeNode("f", { action: "group-pickup", code: "*8" })]),
		);
		expect(picked.hangupCause).toBe("FACILITY_NOT_IMPLEMENTED");
	});
});
