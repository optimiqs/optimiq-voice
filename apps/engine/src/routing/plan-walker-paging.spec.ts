import { describe, expect, it } from "bun:test";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { AUTO_ANSWER_ALERT_INFO, AUTO_ANSWER_CALL_INFO } from "./auto-answer";
import { CallSignalBus, legSignalKey } from "./call-signals";
import { planOf } from "./plan-fixtures.fake";
import { PlanWalker } from "./plan-walker";
import type { WalkerChannel, WalkInput } from "./plan-walker";
import type { CallEvent } from "@optimiq-voice/events";
import type { PagingPlanNode, PlanNode } from "@optimiq-voice/routing";
import type { Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * `*81` — one voice into every handset in a group.
 *
 * ## What these specs are actually guarding
 *
 * Three things, and each of them is a way a page silently half-works:
 *
 * 1. **Every member is originated with the auto-answer headers.** Without them a page is a ring-all
 *    that nobody has to answer, and it looks fine from the switch.
 * 2. **Every member that comes up JOINS.** The obvious implementation reaches for the walker's
 *    ring-all, which settles on the first answer and cancels the rest — a page that reached one
 *    phone out of twelve and reported success.
 * 3. **`answeredCount` is the truth.** The whole reason `call.paging.started` carries both counts is
 *    that a page to twelve where two handsets were unregistered is a page the person making it
 *    believes reached everybody.
 *
 * The media port is a fake and the signal bus is real, so a handset "answering" is the same race it
 * is in production: the fake emits from inside `originate`, before the call returns, which is exactly
 * what a local endpoint that auto-answers does.
 */

/**
 * Settles the microtask queue.
 *
 * The page's teardown runs detached from the walk — the pager's leg dying is a SIGNAL, and the walk
 * returned `bridged` long before it — so a fixed number of ticks is a guess that breaks every time
 * an await is added to the path. Draining is the assertion these specs actually mean.
 */
async function flush(ticks = 16): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await Promise.resolve();
	}
}

const A_CHANNEL = "1754400000.1";
const A_LEG_ID = "0195c0f0-1c2f-7000-8000-0000000000a1";
const CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000c1";
const ORG_ID = "0195c0f0-1c2f-7000-8000-000000000001";
const GROUP_ID = "0195c0f0-1c2f-7000-8000-0000000000d1";

function pagingNode(overrides: Partial<PagingPlanNode> = {}): PagingPlanNode {
	return {
		id: "page",
		kind: "paging",
		label: "Warehouse",
		pagingGroupId: GROUP_ID,
		members: ["2001", "2002"],
		duplex: false,
		// One second. The fan-out's deadline is the only real timer in these specs — a member that
		// never comes up has to be waited out — and a fake that has already answered synchronously
		// does not need any of it.
		timeoutSeconds: 1,
		...overrides,
	};
}

interface HarnessOptions {
	/** Extensions whose handset comes up. Absent means every member answers. */
	readonly answers?: readonly string[];
	/** Makes `mute` refuse, which a one-way page has to survive without dropping the member. */
	readonly muteFails?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	const verbs: Verb[] = [];
	const published: { readonly type: CallEvent; readonly data: Record<string, unknown> }[] = [];
	const state = { answered: false, tearingDown: false };
	const answers = options.answers;
	const comesUp = (number: string): boolean => answers === undefined || answers.includes(number);

	const media = makeFakeMediaPort({
		onOriginate: (request) => {
			// The number is the tail of the endpoint the walker built from its dial template.
			const number = request.endpoint.replace("PJSIP/", "");
			if (comesUp(number)) {
				signals.emit(legSignalKey(request.channelId), { kind: "answered" });
			}
		},
	});

	if (options.muteFails === true) {
		const mute = media.mute.bind(media);
		(
			media as { mute: (channelId: string, direction: "in" | "out" | "both") => Promise<void> }
		).mute = async (channelId, direction) => {
			await mute(channelId, direction);
			throw new Error("this channel cannot be muted");
		};
	}

	const channel: WalkerChannel = {
		mediaChannelId: A_CHANNEL,
		channelId: A_LEG_ID,
		callId: CALL_ID,
		organizationId: ORG_ID,
		callerIdNumber: "1001",
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
		publish: async (type, data) => {
			published.push({ type, data });
		},
		// One second, not the node's five: what these specs are about is which legs joined, and the
		// deadline only has to be long enough for a fake to have answered — which it already has,
		// synchronously, before the originate returned.
		settings: { answerTimeoutMs: 200, defaultRingTimeoutSeconds: 1 },
		newId: () => {
			counter += 1;
			return `id-${String(counter)}`;
		},
		delay: async () => undefined,
	});

	/** Ends the pager's leg, as the media server would when they hang up. */
	const pagerHangsUp = (): void => {
		state.tearingDown = true;
		signals.emit(legSignalKey(A_CHANNEL), {
			kind: "ended",
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});
	};

	return { walker, media, verbs, published, pagerHangsUp };
}

function walkInput(nodes: readonly PlanNode[], extra: Partial<WalkInput> = {}): WalkInput {
	return { plan: planOf(nodes), ...extra };
}

function eventOf(
	published: readonly { readonly type: CallEvent; readonly data: Record<string, unknown> }[],
	type: CallEvent,
): Record<string, unknown> | undefined {
	return published.find((entry) => entry.type === type)?.data;
}

describe("a paging node", () => {
	it("originates to EVERY member with both auto-answer headers", async () => {
		const h = harness();
		await h.walker.walk(walkInput([pagingNode({ members: ["2001", "2002", "2003"] })]));

		const originated = h.media.originated();
		expect(originated.map((request) => request.endpoint)).toEqual([
			"PJSIP/2001",
			"PJSIP/2002",
			"PJSIP/2003",
		]);
		for (const request of originated) {
			expect(request.variables?.["PJSIP_HEADER(add,Alert-Info)"]).toBe(AUTO_ANSWER_ALERT_INFO);
			expect(request.variables?.["PJSIP_HEADER(add,Call-Info)"]).toContain(AUTO_ANSWER_CALL_INFO);
		}
	});

	it("puts every member that answered into ONE bridge, not just the first", async () => {
		// The property that a ring-all implementation would fail: `dialSimultaneous` settles on the
		// first answer and hangs the rest up with `LOSE_RACE`.
		const h = harness();
		const outcome = await h.walker.walk(walkInput([pagingNode()]));

		expect(outcome.status).toBe("bridged");
		const bridges = h.media.calls.filter((call) => call.method === "createBridge");
		expect(bridges).toHaveLength(1);

		const joins = h.media.calls
			.filter((call) => call.method === "addToBridge")
			.map((call) => call.args[1] as string[]);
		// The pager first, then each member as its own leg arrives.
		expect(joins).toHaveLength(3);
		expect(joins[0]).toEqual([A_CHANNEL]);
		expect(new Set(joins.slice(1).flat()).size).toBe(2);
	});

	it("mutes each member's INPUT on a one-way page", async () => {
		const h = harness();
		await h.walker.walk(walkInput([pagingNode({ duplex: false })]));

		const mutes = h.media.calls.filter((call) => call.method === "mute");
		expect(mutes).toHaveLength(2);
		// `in` is audio coming FROM the party. Muting `out` would deafen them, which is the whole
		// content of the page.
		expect(mutes.every((call) => call.args[1] === "in")).toBe(true);
	});

	it("mutes nobody on a talkback page", async () => {
		const h = harness();
		await h.walker.walk(walkInput([pagingNode({ duplex: true })]));
		expect(h.media.calls.some((call) => call.method === "mute")).toBe(false);
	});

	it("keeps a member who cannot be muted, and says they can be heard", async () => {
		// One live microphone in a one-way page is a much better outcome than one handset fewer.
		const h = harness({ muteFails: true });
		const outcome = await h.walker.walk(walkInput([pagingNode({ members: ["2001"] })]));

		expect(outcome.status).toBe("bridged");
		expect(eventOf(h.published, "call.paging.started")?.answeredCount).toBe(1);
		expect(outcome.notes.join(" ")).toContain("could not be muted");
	});

	it("publishes both counts, so a page that half-landed is visible", async () => {
		const h = harness({ answers: ["2001"] });
		await h.walker.walk(
			walkInput([pagingNode({ members: ["2001", "2002", "2003"] })], {
				originalDialedNumber: "*8150",
			}),
		);

		expect(eventOf(h.published, "call.paging.started")).toEqual({
			legId: A_LEG_ID,
			pagingGroupId: GROUP_ID,
			pagingGroupName: "Warehouse",
			dialed: "*8150",
			pagerExtension: "1001",
			memberCount: 3,
			answeredCount: 1,
			oneWay: true,
		});
	});

	it("announces and hangs up when NOBODY answered, rather than opening a silent bridge", async () => {
		const h = harness({ answers: [] });
		const outcome = await h.walker.walk(walkInput([pagingNode()]));

		expect(outcome.hangupCause).toBe("NO_ANSWER");
		expect(h.published.some((entry) => entry.type === "call.paging.started")).toBe(false);
		expect(h.media.calls.some((call) => call.method === "destroyBridge")).toBe(true);
		expect(outcome.notes.join(" ")).toContain("none of its 2 members answered");
	});

	it("refuses a group with no members without answering the pager", async () => {
		const h = harness();
		const outcome = await h.walker.walk(walkInput([pagingNode({ members: [] })]));

		expect(h.media.originated()).toEqual([]);
		expect(outcome.hangupCause).toBe("NO_ANSWER");
		expect(outcome.notes.join(" ")).toContain("no members to page");
	});

	it("ends the page when the PAGER hangs up: members released, bridge destroyed, event bounded", async () => {
		const h = harness();
		await h.walker.walk(walkInput([pagingNode()]));
		h.pagerHangsUp();
		await flush();

		const ended = eventOf(h.published, "call.paging.ended");
		expect(ended?.pagingGroupId).toBe(GROUP_ID);
		expect(ended?.answeredCount).toBe(2);
		expect(typeof ended?.durationMs).toBe("number");
		// The members are hung up with the page, and the bridge goes with them.
		expect(h.media.hungUp().filter((entry) => entry.cause === "NORMAL_CLEARING")).toHaveLength(2);
		expect(h.media.calls.some((call) => call.method === "destroyBridge")).toBe(true);
	});

	it("cancels a member who never came up with ORIGINATOR_CANCEL, not LOSE_RACE", async () => {
		// Nobody lost anything: the page simply started without them.
		const h = harness({ answers: ["2001"] });
		await h.walker.walk(walkInput([pagingNode()]));

		const cancelled = h.media.hungUp();
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]?.cause).toBe("ORIGINATOR_CANCEL");
	});
});
