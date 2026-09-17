import { describe, expect, it } from "bun:test";
import { WEBHOOK_FAMILIES, WEBHOOK_FAMILY_ROOTS } from "./contracts";
import {
	MAX_SELECTOR_LENGTH,
	MAX_WEBHOOK_SELECTORS,
	WEBHOOK_FAMILY_DESCRIPTIONS,
	WEBHOOK_FAMILY_LABELS,
	buildSelectors,
	familyWildcard,
	invalidSelectorsMessage,
	invalidWebhookSelectors,
	isFamilyWildcard,
	parseSelectorInput,
	parseWebhookSelector,
	selectorLabel,
	selectorListIssue,
	splitSelectors,
} from "./webhook-selectors";

/**
 * The grammar is a MIRROR of `apps/api/src/pbx/webhooks/webhook-selectors.ts`, and it cannot be
 * anything else: the server builds its four roots from `@optimiq-voice/events`, which is not a
 * dependency of this app and must not become one — it carries the broker's codecs.
 *
 * So every case below is written as a LITERAL rather than derived from an import, and the literals
 * are the server's own: the three forms its header documents as valid, the four families it
 * deliberately does not serve, and the refusals its `parseWebhookSelector` makes. Deriving them
 * would prove only that this file agrees with itself.
 *
 * ## What a drifted mirror actually costs
 *
 * A selector this file accepts and the server refuses is a 400 after a round trip — annoying, and
 * visible. The expensive direction is the other one: a selector this file refuses that the server
 * would have served removes a delivery the tenant asked for, and the only evidence is an endpoint
 * that never fires — indistinguishable from a broken endpoint, a broken network, or a platform
 * that is not publishing.
 */

/** The four roots, spelled out. `cdr` is `cdr.leg.v1`, NOT `cdr.evt.v1`. */
const ROOTS = {
	call: "calls.evt.v1",
	queue: "queue.evt.v1",
	voicemail: "voicemail.evt.v1",
	cdr: "cdr.leg.v1",
} as const;

describe("the four selectable families", () => {
	it("spells each root the way the platform publishes it", () => {
		expect(WEBHOOK_FAMILY_ROOTS).toEqual(ROOTS);
		expect(WEBHOOK_FAMILIES).toEqual(["call", "queue", "voicemail", "cdr"]);
	});

	/**
	 * The `cdr` root is the one worth an assertion of its own. `cdr.evt.v1` is a plausible-looking
	 * subject that the platform never publishes, so a subscription naming it would parse in a
	 * reader's head and match nothing forever.
	 */
	it("uses the leg root for call records, not an event root", () => {
		expect(WEBHOOK_FAMILY_ROOTS.cdr).toBe("cdr.leg.v1");
		expect(parseWebhookSelector("cdr.evt.v1.>")).toBeUndefined();
	});

	it("labels and describes every family the builder can offer", () => {
		for (const family of WEBHOOK_FAMILIES) {
			expect(WEBHOOK_FAMILY_LABELS[family].length).toBeGreaterThan(0);
			expect(WEBHOOK_FAMILY_DESCRIPTIONS[family].length).toBeGreaterThan(0);
		}
	});

	it("mirrors the server's array bounds", () => {
		expect(MAX_WEBHOOK_SELECTORS).toBe(32);
		expect(MAX_SELECTOR_LENGTH).toBe(128);
	});
});

describe("parseWebhookSelector — the forms the server accepts", () => {
	/** The three shapes `webhook-selectors.ts` documents in its header, verbatim. */
	it("accepts a family wildcard", () => {
		expect(parseWebhookSelector("calls.evt.v1.>")).toEqual({ family: "call" });
		expect(parseWebhookSelector("queue.evt.v1.>")).toEqual({ family: "queue" });
		expect(parseWebhookSelector("voicemail.evt.v1.>")).toEqual({ family: "voicemail" });
		expect(parseWebhookSelector("cdr.leg.v1.>")).toEqual({ family: "cdr" });
	});

	it("accepts one exact event type in a family", () => {
		expect(parseWebhookSelector("calls.evt.v1.channel.answered")).toEqual({
			family: "call",
			type: "channel.answered",
		});
	});

	/** Event names are hierarchical, so a type is one or more dot-separated tokens. */
	it("accepts a deep event name", () => {
		expect(parseWebhookSelector("calls.evt.v1.channel.record.started")).toEqual({
			family: "call",
			type: "channel.record.started",
		});
		expect(parseWebhookSelector("queue.evt.v1.abandoned")).toEqual({
			family: "queue",
			type: "abandoned",
		});
	});

	it("accepts the token characters the grammar allows", () => {
		expect(parseWebhookSelector("voicemail.evt.v1.message_left")?.type).toBe("message_left");
		expect(parseWebhookSelector("voicemail.evt.v1.message-left")?.type).toBe("message-left");
		expect(parseWebhookSelector("cdr.leg.v1.leg2")?.type).toBe("leg2");
	});

	it("trims surrounding whitespace before deciding", () => {
		expect(parseWebhookSelector("  calls.evt.v1.>  ")).toEqual({ family: "call" });
	});
});

describe("parseWebhookSelector — the forms the server refuses", () => {
	/**
	 * The tenant boundary, restated as a test. A selector deliberately CANNOT express an
	 * organization token: a real subject carries `<orgId>.<callId>` between the root and the event,
	 * so anything shaped like one has a `>` or a `*` in the middle and fails the event pattern.
	 * This is the case that would otherwise become a string comparison somebody has to remember.
	 */
	it("cannot name another tenant", () => {
		expect(
			parseWebhookSelector("calls.evt.v1.0193f2aa-0000-7000-8000-0000000000ff.>"),
		).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.*.channel.answered")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.>.channel.answered")).toBeUndefined();
	});

	/**
	 * `*` is refused rather than treated as a synonym for `>`: a single-token wildcard would match
	 * `channel` and not `channel.answered`, which is a distinction nobody wants to discover from an
	 * endpoint that receives half a family.
	 */
	it("refuses the single-token wildcard", () => {
		expect(parseWebhookSelector("calls.evt.v1.*")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.channel.*")).toBeUndefined();
	});

	/**
	 * The four families the platform publishes and webhooks deliberately do not serve: engine
	 * plumbing, a per-REGISTER firehose, the ledger that records webhook edits, and
	 * credential-adjacent provisioning detail.
	 */
	it("refuses every family that is not deliverable", () => {
		expect(parseWebhookSelector("media.evt.v1.>")).toBeUndefined();
		expect(parseWebhookSelector("sip.reg.v1.>")).toBeUndefined();
		expect(parseWebhookSelector("audit.evt.v1.>")).toBeUndefined();
		expect(parseWebhookSelector("provision.evt.v1.>")).toBeUndefined();
	});

	it("refuses a root with no event and no wildcard", () => {
		expect(parseWebhookSelector("calls.evt.v1")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt")).toBeUndefined();
	});

	it("refuses an empty token inside an event name", () => {
		expect(parseWebhookSelector("calls.evt.v1.channel..answered")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.channel.answered.")).toBeUndefined();
	});

	it("refuses whitespace and punctuation the grammar has no token for", () => {
		expect(parseWebhookSelector("calls.evt.v1.channel answered")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.channel/answered")).toBeUndefined();
		expect(parseWebhookSelector("calls.evt.v1.channel:answered")).toBeUndefined();
	});

	it("refuses an empty selector and one past the length cap", () => {
		expect(parseWebhookSelector("")).toBeUndefined();
		expect(parseWebhookSelector("   ")).toBeUndefined();
		const overlong = `calls.evt.v1.${"a".repeat(MAX_SELECTOR_LENGTH)}`;
		expect(overlong.length).toBeGreaterThan(MAX_SELECTOR_LENGTH);
		expect(parseWebhookSelector(overlong)).toBeUndefined();
	});

	/** A subject that is a real NATS subject and is not a selector. */
	it("refuses a wholly unknown root", () => {
		expect(parseWebhookSelector("rpc.routing.v1.resolve")).toBeUndefined();
		expect(parseWebhookSelector("calls")).toBeUndefined();
		expect(parseWebhookSelector(">")).toBeUndefined();
	});
});

describe("isFamilyWildcard", () => {
	it("separates the two accepted forms", () => {
		expect(isFamilyWildcard("calls.evt.v1.>")).toBe(true);
		expect(isFamilyWildcard("calls.evt.v1.channel.answered")).toBe(false);
		expect(isFamilyWildcard("media.evt.v1.>")).toBe(false);
	});
});

describe("familyWildcard", () => {
	it("writes the `>` form the multi-select stores", () => {
		expect(familyWildcard("call")).toBe("calls.evt.v1.>");
		expect(familyWildcard("cdr")).toBe("cdr.leg.v1.>");
	});

	/** Everything the builder writes must be something the parser reads back. */
	it("produces a selector for every family it can be asked about", () => {
		for (const family of WEBHOOK_FAMILIES) {
			expect(parseWebhookSelector(familyWildcard(family))).toEqual({ family });
		}
	});
});

describe("invalidWebhookSelectors", () => {
	it("reports the bad ones in the order they were given", () => {
		expect(
			invalidWebhookSelectors([
				"calls.evt.v1.>",
				"media.evt.v1.>",
				"cdr.leg.v1.>",
				"calls.evt.v1.*",
			]),
		).toEqual(["media.evt.v1.>", "calls.evt.v1.*"]);
	});

	it("reports nothing about a list the server would accept", () => {
		expect(invalidWebhookSelectors(["calls.evt.v1.>", "queue.evt.v1.answered"])).toEqual([]);
	});
});

describe("invalidSelectorsMessage", () => {
	/**
	 * The server's own sentence, restated so the form says the same thing before the round trip that
	 * the 400 would say after it. A rule enforced in two places must not be explained in two ways.
	 */
	it("matches the message the DTO produces", () => {
		expect(invalidSelectorsMessage(["media.evt.v1.>", "calls.evt.v1.*"])).toBe(
			"unknown event selector(s): media.evt.v1.>, calls.evt.v1.*. Use a family wildcard " +
				"(`calls.evt.v1.>`) or an exact type (`calls.evt.v1.channel.answered`).",
		);
	});
});

describe("parseSelectorInput", () => {
	it("splits on commas and on whitespace, which is what a pasted list carries", () => {
		expect(parseSelectorInput("calls.evt.v1.>, queue.evt.v1.>")).toEqual([
			"calls.evt.v1.>",
			"queue.evt.v1.>",
		]);
		expect(parseSelectorInput("calls.evt.v1.>\nqueue.evt.v1.>\n")).toEqual([
			"calls.evt.v1.>",
			"queue.evt.v1.>",
		]);
	});

	/** A blank fragment would become a zero-length selector the server refuses over its LENGTH. */
	it("drops blank fragments rather than sending them", () => {
		expect(parseSelectorInput("  ")).toEqual([]);
		expect(parseSelectorInput(",,calls.evt.v1.>,,")).toEqual(["calls.evt.v1.>"]);
	});

	/**
	 * Duplicates are removed keeping the FIRST occurrence, so the list read back is the one that was
	 * typed. The server does not deduplicate, and a subscription holding the same selector twice
	 * spends one of its 32 slots on nothing.
	 */
	it("removes duplicates and keeps the order they were typed in", () => {
		expect(parseSelectorInput("queue.evt.v1.>, calls.evt.v1.>, queue.evt.v1.>")).toEqual([
			"queue.evt.v1.>",
			"calls.evt.v1.>",
		]);
	});

	/** Unknown entries survive the split — refusing them is `selectorListIssue`'s job, with a message. */
	it("keeps a fragment it cannot parse so the message can name it", () => {
		expect(parseSelectorInput("media.evt.v1.>")).toEqual(["media.evt.v1.>"]);
	});
});

describe("splitSelectors", () => {
	it("separates the checkboxes from the textarea", () => {
		expect(splitSelectors(["calls.evt.v1.>", "queue.evt.v1.answered", "cdr.leg.v1.>"])).toEqual({
			families: ["call", "cdr"],
			types: ["queue.evt.v1.answered"],
			unknown: [],
		});
	});

	/**
	 * A selector the platform no longer serves lands in `unknown` rather than being dropped:
	 * silently discarding it on edit would delete a subscription's filter as a side effect of
	 * OPENING a form.
	 */
	it("keeps a selector it cannot parse instead of quietly losing it", () => {
		expect(splitSelectors(["calls.evt.v1.>", "media.evt.v1.>"]).unknown).toEqual([
			"media.evt.v1.>",
		]);
	});

	it("collapses a stored list that repeats itself", () => {
		const split = splitSelectors([
			"calls.evt.v1.>",
			"calls.evt.v1.>",
			"queue.evt.v1.answered",
			"queue.evt.v1.answered",
		]);
		expect(split.families).toEqual(["call"]);
		expect(split.types).toEqual(["queue.evt.v1.answered"]);
	});

	/** Reopening an editor must round trip: what was stored is what the two controls show. */
	it("round trips what buildSelectors wrote", () => {
		const stored = buildSelectors(["cdr", "call"], ["queue.evt.v1.answered"]);
		const split = splitSelectors(stored);
		expect(buildSelectors(split.families, split.types)).toEqual(stored);
	});
});

describe("buildSelectors", () => {
	/**
	 * Family wildcards first and in the platform's OWN family order, so two subscriptions that
	 * select the same thing store the same array. An order that followed the order the boxes were
	 * ticked would make the audit diff of an unrelated edit look like a selector change.
	 */
	it("writes families in platform order regardless of how they were ticked", () => {
		expect(buildSelectors(["cdr", "call"], [])).toEqual(["calls.evt.v1.>", "cdr.leg.v1.>"]);
		expect(buildSelectors(["call", "cdr"], [])).toEqual(["calls.evt.v1.>", "cdr.leg.v1.>"]);
	});

	it("puts the exact types after the wildcards", () => {
		expect(buildSelectors(["call"], ["queue.evt.v1.answered"])).toEqual([
			"calls.evt.v1.>",
			"queue.evt.v1.answered",
		]);
	});

	/**
	 * A wildcard SUBSUMES an exact type in the same family, and the redundant entry is dropped
	 * rather than kept: the dispatcher stops at the first matching selector, so keeping it changes
	 * no delivery and only spends one of the 32 slots.
	 */
	it("drops an exact type a chosen family already covers", () => {
		expect(buildSelectors(["call"], ["calls.evt.v1.channel.answered"])).toEqual(["calls.evt.v1.>"]);
	});

	/** An unparseable entry is NOT dropped — it has to reach `selectorListIssue` to be named. */
	it("keeps an entry it cannot parse so the form can refuse it by name", () => {
		expect(buildSelectors([], ["media.evt.v1.>"])).toEqual(["media.evt.v1.>"]);
	});

	it("builds nothing from nothing", () => {
		expect(buildSelectors([], [])).toEqual([]);
	});
});

describe("selectorLabel", () => {
	it("reads a wildcard as the family and an exact selector as its event", () => {
		expect(selectorLabel("calls.evt.v1.>")).toBe("All call events");
		expect(selectorLabel("cdr.leg.v1.>")).toBe("All cdr events");
		expect(selectorLabel("calls.evt.v1.channel.answered")).toBe("channel.answered");
	});

	/** An unknown selector is shown verbatim: it is a stored value, and hiding it would hide a bug. */
	it("shows a selector it cannot parse exactly as stored", () => {
		expect(selectorLabel("media.evt.v1.>")).toBe("media.evt.v1.>");
	});
});

describe("selectorListIssue", () => {
	/** The three rules are the server's array bounds and its vocabulary, in the order a user hits them. */
	it("refuses a subscription that selects nothing", () => {
		expect(selectorListIssue([])).toBe(
			"Choose at least one family, or name an exact event type. A subscription that selects nothing never fires.",
		);
	});

	it("refuses a list past the server's cap", () => {
		const many = Array.from(
			{ length: MAX_WEBHOOK_SELECTORS + 1 },
			(_, index) => `calls.evt.v1.type${String(index)}`,
		);
		expect(selectorListIssue(many)).toBe(
			"At most 32 selectors. A family wildcard replaces every exact type in it.",
		);
		expect(selectorListIssue(many.slice(0, MAX_WEBHOOK_SELECTORS))).toBeUndefined();
	});

	it("names the entries the server would not recognise", () => {
		expect(selectorListIssue(["calls.evt.v1.>", "media.evt.v1.>"])).toBe(
			invalidSelectorsMessage(["media.evt.v1.>"]),
		);
	});

	it("says nothing about a list the server would accept", () => {
		expect(selectorListIssue(buildSelectors(["call", "cdr"], []))).toBeUndefined();
	});
});
