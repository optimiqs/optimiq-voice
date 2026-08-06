import { expect } from "chai";
import {
	projectQueueMemberships,
	renderExtensionDialString,
} from "../../src/pbx/queues/queue-membership.projection";
import type {
	QueueRosterQueueRow,
	QueueRosterTierRow,
} from "../../src/pbx/queues/queue-membership.projection";

/**
 * The pure half of the queue-membership publisher.
 *
 * What is worth pinning here is everything the ENGINE would be unable to recover from: a dial
 * string it cannot use, an order that is not the one the tiers declare, and a seat that would make
 * it ring a phone that does not exist. The KV round trip is `verify-pbx.ts`'s job.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const QUEUE_A = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const QUEUE_B = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const AGENT_A = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const AGENT_B = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const EXTENSION = "019fd3c2-6666-76be-a6b3-b0f1914e39b6";
const NOW = new Date("2026-08-06T09:00:00.000Z");

function queueRow(overrides: Partial<QueueRosterQueueRow> = {}): QueueRosterQueueRow {
	return {
		id: QUEUE_A,
		name: "Support",
		wrapUpSeconds: 10,
		tierRulesApply: true,
		tierRuleWaitSeconds: 30,
		tierRuleNoAgentNoWait: false,
		...overrides,
	};
}

function tierRow(overrides: Partial<QueueRosterTierRow> = {}): QueueRosterTierRow {
	return {
		queueId: QUEUE_A,
		agentId: AGENT_A,
		agentName: "Ada Lovelace",
		contactKind: "extension",
		contact: null,
		extensionId: EXTENSION,
		extensionNumber: "1001",
		level: 1,
		position: 1,
		wrapUpSeconds: 10,
		maxNoAnswer: 3,
		noAnswerDelaySeconds: 30,
		busyDelaySeconds: 60,
		rejectDelaySeconds: 60,
		enabled: true,
		...overrides,
	};
}

const options = { extensionDialTemplate: "PJSIP/{number}", now: NOW };

describe("projectQueueMemberships", () => {
	it("emits one roster per queue, including queues nobody serves", () => {
		const { memberships } = projectQueueMemberships(
			ORG,
			[queueRow(), queueRow({ id: QUEUE_B, name: "Nights" })],
			[tierRow()],
			options,
		);
		expect(memberships).to.have.length(2);
		expect(memberships[1]?.agents).to.deep.equal([]);
	});

	/**
	 * A queue with no key at all is one the engine REFUSES to distribute against; a queue with an
	 * empty roster is one it distributes against and finds nobody. Those are different states and
	 * the second is the honest one for an unstaffed queue, so the entry has to be written.
	 */
	it("gives an unstaffed queue an entry rather than leaving it absent", () => {
		const { memberships } = projectQueueMemberships(ORG, [queueRow()], [], options);
		expect(memberships).to.have.length(1);
		expect(memberships[0]?.agents).to.deep.equal([]);
		expect(memberships[0]?.queueId).to.equal(QUEUE_A);
	});

	it("resolves an extension agent's contact through the dial template", () => {
		const { memberships } = projectQueueMemberships(ORG, [queueRow()], [tierRow()], options);
		expect(memberships[0]?.agents[0]?.contact).to.equal("PJSIP/1001");
		expect(memberships[0]?.agents[0]?.extensionId).to.equal(EXTENSION);
	});

	it("uses a deployment's own template rather than assuming PJSIP", () => {
		const { memberships } = projectQueueMemberships(ORG, [queueRow()], [tierRow()], {
			...options,
			extensionDialTemplate: "Local/{number}@optimiq-loopback/n",
		});
		expect(memberships[0]?.agents[0]?.contact).to.equal("Local/1001@optimiq-loopback/n");
	});

	it("passes an external agent's dial string through untouched", () => {
		const { memberships } = projectQueueMemberships(
			ORG,
			[queueRow()],
			[
				tierRow({
					contactKind: "external",
					contact: "PJSIP/+15551234567@carrier-a",
					extensionId: null,
					extensionNumber: null,
				}),
			],
			options,
		);
		expect(memberships[0]?.agents[0]?.contact).to.equal("PJSIP/+15551234567@carrier-a");
		expect(memberships[0]?.agents[0]?.contactKind).to.equal("external");
	});

	/**
	 * `extension_id` is `on delete set null`, so deleting an extension leaves an agent nothing can
	 * dial. Publishing them would cost every waiting caller a full ring timeout for a phone that
	 * does not exist; throwing would stop the queue's OTHER agents being published at all.
	 */
	it("drops an extension agent whose extension is gone, and reports it", () => {
		const { memberships, unreachable } = projectQueueMemberships(
			ORG,
			[queueRow()],
			[tierRow({ extensionId: null, extensionNumber: null }), tierRow({ agentId: AGENT_B, position: 2 })],
			options,
		);
		expect(memberships[0]?.agents).to.have.length(1);
		expect(memberships[0]?.agents[0]?.agentId).to.equal(AGENT_B);
		expect(unreachable).to.have.length(1);
		expect(unreachable[0]?.reason).to.equal("no-extension");
		expect(unreachable[0]?.agentName).to.equal("Ada Lovelace");
	});

	it("drops an external agent with no number and says why", () => {
		const { unreachable } = projectQueueMemberships(
			ORG,
			[queueRow()],
			[tierRow({ contactKind: "external", contact: null, extensionId: null, extensionNumber: null })],
			options,
		);
		expect(unreachable[0]?.reason).to.equal("no-contact");
	});

	/**
	 * A disabled seat is IN the roster with `enabled: false`. Dropping it would make "this agent is
	 * turned off" and "this agent does not serve this queue" indistinguishable to every reader.
	 */
	it("keeps a disabled agent in the roster", () => {
		const { memberships, unreachable } = projectQueueMemberships(
			ORG,
			[queueRow()],
			[tierRow({ enabled: false })],
			options,
		);
		expect(memberships[0]?.agents).to.have.length(1);
		expect(memberships[0]?.agents[0]?.enabled).to.equal(false);
		expect(unreachable).to.have.length(0);
	});

	/**
	 * The ORDER is part of the value: `top-down` and `round-robin` walk it. A roster that arrived
	 * in a different order after an unrelated write would silently change who rings first.
	 */
	it("orders seats by level, then position, then id", () => {
		const { memberships } = projectQueueMemberships(
			ORG,
			[queueRow()],
			[
				tierRow({ agentId: AGENT_B, level: 2, position: 1 }),
				tierRow({ agentId: AGENT_A, level: 1, position: 2 }),
			],
			options,
		);
		expect(memberships[0]?.agents.map((agent) => agent.level)).to.deep.equal([1, 2]);
		expect(memberships[0]?.agents[0]?.agentId).to.equal(AGENT_A);
	});

	it("carries the queue's tier rules, which are meaningless without the tiers", () => {
		const { memberships } = projectQueueMemberships(
			ORG,
			[queueRow({ tierRulesApply: false, tierRuleWaitSeconds: 0, tierRuleNoAgentNoWait: true })],
			[tierRow()],
			options,
		);
		expect(memberships[0]?.tierRulesApply).to.equal(false);
		expect(memberships[0]?.tierRuleNoAgentNoWait).to.equal(true);
	});

	/**
	 * The engine logs the revision, so "was I distributing against an old roster?" has an answer.
	 * A counter that restarted at 1 on every write would answer it wrongly rather than not at all.
	 */
	it("advances the revision from the previous entry", () => {
		const { memberships } = projectQueueMemberships(ORG, [queueRow()], [tierRow()], {
			...options,
			previousRevisions: new Map([[QUEUE_A, 7]]),
		});
		expect(memberships[0]?.revision).to.equal(8);
	});

	it("starts a queue the bucket has never held at revision 1", () => {
		const { memberships } = projectQueueMemberships(ORG, [queueRow()], [tierRow()], options);
		expect(memberships[0]?.revision).to.equal(1);
	});

	it("stamps the organization the caller named, never one from a row", () => {
		const { memberships } = projectQueueMemberships(ORG, [queueRow()], [tierRow()], options);
		expect(memberships[0]?.orgId).to.equal(ORG);
		expect(memberships[0]?.updatedAt).to.equal(NOW.toISOString());
	});

	/** A roster that does not satisfy the contract must not reach the bucket at all. */
	it("validates against the shared schema, so an impossible level cannot be published", () => {
		expect(() =>
			projectQueueMemberships(ORG, [queueRow()], [tierRow({ level: 0 })], options),
		).to.throw();
	});
});

describe("renderExtensionDialString", () => {
	it("replaces every occurrence, not just the first", () => {
		expect(renderExtensionDialString("SIP/{number}@{number}.local", "1001")).to.equal(
			"SIP/1001@1001.local",
		);
	});
});
