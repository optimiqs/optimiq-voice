import { expect } from "chai";
import {
	invalidWebhookSelectors,
	isWebhookFamily,
	parseWebhookSelector,
	selectorsMatch,
	unservedEventFamilies,
	WEBHOOK_FAMILIES,
} from "../../src/pbx/webhooks/webhook-selectors";

/**
 * The selector grammar, which is the tenant boundary expressed as a parser.
 *
 * The assertions worth making are the NEGATIVE ones: a selector cannot name an organization, cannot
 * name a family this platform does not serve over webhooks, and cannot be a subject filter that
 * happens to match. If any of those started passing, a subscription would be able to ask for
 * somebody else's events and the only thing between it and them would be a comment.
 */

describe("webhook selectors", () => {
	it("accepts a family wildcard for every servable family", () => {
		for (const selector of [
			"calls.evt.v1.>",
			"queue.evt.v1.>",
			"voicemail.evt.v1.>",
			"cdr.leg.v1.>",
		]) {
			expect(parseWebhookSelector(selector), selector).to.not.equal(undefined);
			expect(parseWebhookSelector(selector)?.type, selector).to.equal(undefined);
		}
	});

	it("accepts an exact event type, including a multi-token one", () => {
		expect(parseWebhookSelector("calls.evt.v1.channel.answered")).to.deep.equal({
			family: "call",
			type: "channel.answered",
		});
		expect(parseWebhookSelector("calls.evt.v1.channel.record.started")?.type).to.equal(
			"channel.record.started",
		);
		expect(parseWebhookSelector("queue.evt.v1.caller.abandoned")).to.deep.equal({
			family: "queue",
			type: "caller.abandoned",
		});
	});

	/** The whole point of the grammar. */
	it("cannot express an organization, so a selector can never name another tenant", () => {
		const otherOrg = "0195c0f0-1c2f-7000-8000-000000000002";
		// A real subject filter — the thing a naive design would have accepted.
		expect(parseWebhookSelector(`calls.evt.v1.${otherOrg}.>`)).to.equal(undefined);
		expect(parseWebhookSelector(`calls.evt.v1.${otherOrg}.*.channel.answered`)).to.equal(undefined);
		expect(parseWebhookSelector("calls.evt.v1.*.*.channel.answered")).to.equal(undefined);
	});

	it("refuses a family this platform does not serve over webhooks", () => {
		for (const selector of [
			"media.evt.v1.>",
			"sip.reg.v1.>",
			"audit.evt.v1.>",
			"provision.evt.v1.>",
		]) {
			expect(parseWebhookSelector(selector), selector).to.equal(undefined);
		}
	});

	it("refuses a bare root, a wrong version and an empty string", () => {
		expect(parseWebhookSelector("calls.evt.v1")).to.equal(undefined);
		expect(parseWebhookSelector("calls.evt.v2.>")).to.equal(undefined);
		expect(parseWebhookSelector("   ")).to.equal(undefined);
		expect(parseWebhookSelector(`calls.evt.v1.${"x".repeat(200)}`)).to.equal(undefined);
	});

	it("names every invalid selector in a list, so a 400 can say which", () => {
		expect(invalidWebhookSelectors(["calls.evt.v1.>", "media.evt.v1.>", "nonsense"])).to.deep.equal(
			["media.evt.v1.>", "nonsense"],
		);
	});

	it("matches a family wildcard against every type in that family and nothing outside it", () => {
		const selectors = ["calls.evt.v1.>"];
		expect(selectorsMatch(selectors, "call", "channel.answered")).to.equal(true);
		expect(selectorsMatch(selectors, "call", "call.parked")).to.equal(true);
		expect(selectorsMatch(selectors, "queue", "caller.joined")).to.equal(false);
	});

	it("matches an exact type and refuses its neighbours", () => {
		const selectors = ["calls.evt.v1.channel.answered"];
		expect(selectorsMatch(selectors, "call", "channel.answered")).to.equal(true);
		expect(selectorsMatch(selectors, "call", "channel.hangup")).to.equal(false);
		// Not a prefix match: `channel` must not stand in for `channel.answered`.
		expect(selectorsMatch(selectors, "call", "channel")).to.equal(false);
	});

	it("ignores a selector it cannot parse rather than treating it as a wildcard", () => {
		// Belt and braces: the DTO refuses these on write, so one in the column is a row that predates
		// a vocabulary change. Failing open there would deliver everything to everybody.
		expect(selectorsMatch(["nonsense"], "call", "channel.answered")).to.equal(false);
		expect(selectorsMatch([], "call", "channel.answered")).to.equal(false);
	});

	it("keeps the unserved families a decision rather than an omission", () => {
		expect([...unservedEventFamilies()].sort()).to.deep.equal([
			"audit",
			"media",
			"provision",
			"registration",
		]);
		for (const family of WEBHOOK_FAMILIES) {
			expect(isWebhookFamily(family), family).to.equal(true);
		}
		expect(isWebhookFamily("media")).to.equal(false);
	});
});
