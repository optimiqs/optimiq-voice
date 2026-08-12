import { expect } from "chai";
import { resolveRolePermissions } from "../../src/auth/role-permissions";
import {
	allowedTopicKinds,
	formatLiveTopic,
	LIVE_TOPIC_KINDS,
	LIVE_TOPIC_PERMISSIONS,
	LIVE_TOPIC_SOURCES,
	mayReadTopic,
	parseLiveTopic,
	permissionForTopic,
	sourcesForTopic,
} from "../../src/live/live-topics";
import type { LiveTopic } from "../../src/live/live-topics";

const QUEUE = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

/**
 * The live channel's topic grammar and permission mapping.
 *
 * This is the authorization surface of a feature that streams a tenant's live call activity to a
 * browser, so the assertions worth having are the REFUSALS — and in particular the one that is
 * easiest to get wrong by accident: a `.own`-scoped grant must never open an organization-wide
 * feed, because there is no per-connection filter that could narrow one back down.
 */

const QUEUE_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

describe("parseLiveTopic", () => {
	it("accepts the three org-wide topics", () => {
		expect(parseLiveTopic("registrations")).to.deep.equal({ kind: "registrations" });
		expect(parseLiveTopic("active-calls")).to.deep.equal({ kind: "active-calls" });
		expect(parseLiveTopic("agent-state")).to.deep.equal({ kind: "agent-state" });
	});

	it("accepts a queue topic and keeps its id", () => {
		expect(parseLiveTopic(`queue:${QUEUE_ID}`)).to.deep.equal({
			kind: "queue",
			queueId: QUEUE_ID,
		});
	});

	/**
	 * The id becomes a NATS subject token. A value that is not one would either throw inside the
	 * subject builder or — much worse — build a filter with a wildcard in it, which is a
	 * cross-queue subscription the permission check already approved.
	 */
	it("refuses a queue id that is not a UUID", () => {
		expect(parseLiveTopic("queue:*")).to.equal(undefined);
		expect(parseLiveTopic("queue:>")).to.equal(undefined);
		expect(parseLiveTopic("queue:")).to.equal(undefined);
		expect(parseLiveTopic("queue:../../etc")).to.equal(undefined);
	});

	it("refuses anything outside the closed vocabulary", () => {
		expect(parseLiveTopic("cdr")).to.equal(undefined);
		expect(parseLiveTopic(">")).to.equal(undefined);
		expect(parseLiveTopic("calls.evt.v1.>")).to.equal(undefined);
	});

	it("accepts the trunks topic", () => {
		expect(parseLiveTopic("trunks")).to.deep.equal({ kind: "trunks" });
	});

	it("round-trips through the wire form", () => {
		for (const name of [
			"registrations",
			"active-calls",
			"agent-state",
			"trunks",
			`queue:${QUEUE_ID}`,
		]) {
			const topic = parseLiveTopic(name);
			expect(topic, name).to.not.equal(undefined);
			expect(formatLiveTopic(topic!)).to.equal(name);
		}
	});
});

describe("the permission mapping", () => {
	it("names a permission and at least one source for every topic kind", () => {
		for (const kind of LIVE_TOPIC_KINDS) {
			expect(LIVE_TOPIC_PERMISSIONS[kind], kind).to.be.a("string");
			expect(LIVE_TOPIC_SOURCES[kind], kind).to.have.length.greaterThan(0);
		}
	});

	it("reads active calls from the channel bucket AND the call stream", () => {
		// A bucket says what IS and a stream says what CHANGED. A wallboard with only the first
		// would have to redraw a whole table to show one leg answering.
		expect(sourcesForTopic({ kind: "active-calls" })).to.deep.equal(["channels-kv", "call-events"]);
	});

	it("gates queue and agent-state on queues.monitor", () => {
		expect(permissionForTopic({ kind: "queue", queueId: QUEUE_ID })).to.equal("queues.monitor");
		expect(permissionForTopic({ kind: "agent-state" })).to.equal("queues.monitor");
	});

	/**
	 * The voicemail argument, applied to carriers: the topic carries the same status word, reason
	 * and round-trip time `GET /trunks` already returns to anyone holding `trunks.read`, so gating
	 * "the same row, sooner" differently from the list would either protect nothing or leak the
	 * carrier roster. One stream source and no bucket — the current statuses are the `trunk.status*`
	 * columns the page has already fetched.
	 */
	it("gates trunks on trunks.read and reads only the trunk event stream", () => {
		expect(permissionForTopic({ kind: "trunks" })).to.equal("trunks.read");
		expect(sourcesForTopic({ kind: "trunks" })).to.deep.equal(["trunk-events"]);
	});

	/**
	 * An owner sees everything, which is the trivial case and the one a regression would still pass.
	 */
	it("gives an owner every topic", () => {
		const owner = resolveRolePermissions("owner");
		expect([...allowedTopicKinds(owner)].sort()).to.deep.equal([...LIVE_TOPIC_KINDS].sort());
	});

	/**
	 * The shape this feature is designed around. An agent holds `queues.monitor` and `queues.read`
	 * but only `extensions.read.own` and `cdr.read.own` — so their console sees its queues and its
	 * own state, and is refused the org-wide registration and call feeds. That is the same split the
	 * role templates already draw for the pages; the socket must not widen it.
	 */
	it("gives an agent the queue feeds and refuses the org-wide ones", () => {
		const agent = resolveRolePermissions("agent");
		expect(mayReadTopic(agent, { kind: "queue", queueId: QUEUE_ID })).to.equal(true);
		expect(mayReadTopic(agent, { kind: "agent-state" })).to.equal(true);
		expect(mayReadTopic(agent, { kind: "registrations" })).to.equal(false);
		expect(mayReadTopic(agent, { kind: "active-calls" })).to.equal(false);
		expect([...allowedTopicKinds(agent)].sort()).to.deep.equal(["agent-state", "queue"]);
	});

	it("gives a manager everything, which is what a supervisor's wallboard needs", () => {
		const manager = resolveRolePermissions("manager");
		expect(mayReadTopic(manager, { kind: "registrations" })).to.equal(true);
		expect(mayReadTopic(manager, { kind: "active-calls" })).to.equal(true);
		expect(mayReadTopic(manager, { kind: "queue", queueId: QUEUE_ID })).to.equal(true);
	});

	/**
	 * A plain `user` holds the `.own` scopes and `settings.read` and nothing else. Every topic here
	 * is organization-wide, and there is no filter that could turn one into "the calls you were on".
	 */
	it("gives a plain user nothing at all", () => {
		const user = resolveRolePermissions("user");
		expect(allowedTopicKinds(user)).to.deep.equal([]);
		for (const kind of LIVE_TOPIC_KINDS) {
			const topic = kind === "queue" ? { kind, queueId: QUEUE_ID } : { kind };
			expect(mayReadTopic(user, topic as never), kind).to.equal(false);
		}
	});

	it("does not let a scoped grant satisfy an unscoped requirement", () => {
		expect(mayReadTopic(["cdr.read.own"], { kind: "active-calls" })).to.equal(false);
		expect(mayReadTopic(["extensions.read.own"], { kind: "registrations" })).to.equal(false);
		// …and the documented direction that DOES hold.
		expect(mayReadTopic(["cdr.read"], { kind: "active-calls" })).to.equal(true);
	});
});

/**
 * The waiting line as a live source.
 *
 * What a wallboard needs from a queue topic is three numbers — how many are holding, where each of
 * them stands, how long the front of the line has been there — and all three are one KV record. The
 * assertion that matters is that it is a SNAPSHOT source: a wallboard opening at 09:05 must be shown
 * the callers who joined at 09:04, and a stream-only topic can only ever show it what has happened
 * since it connected.
 */
describe("the queue waiting line", () => {
	it("is a source of the queue topic, alongside the events and the agent states", () => {
		expect(sourcesForTopic({ kind: "queue", queueId: QUEUE })).to.include("queue-waiting-kv");
	});

	it("is not a source of any other topic, because the line is per queue", () => {
		for (const kind of LIVE_TOPIC_KINDS) {
			if (kind === "queue") {
				continue;
			}
			expect(sourcesForTopic({ kind } as LiveTopic)).to.not.include("queue-waiting-kv");
		}
	});

	/** Reading the line is reading the queue. Nothing new to gate, and nothing quietly widened. */
	it("adds no permission of its own — the queue topic's gate already covers it", () => {
		expect(permissionForTopic({ kind: "queue", queueId: QUEUE })).to.equal("queues.monitor");
	});
});
