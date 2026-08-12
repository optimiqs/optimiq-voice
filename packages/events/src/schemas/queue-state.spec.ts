import { describe, expect, it } from "bun:test";
import { KV_BUCKETS, kvKeyFor, QUEUE_MEMBERSHIP_KV, QUEUE_WAITING_KV } from "../streams";
import {
	agentStateEntrySchema,
	QUEUE_WAITING_MAX_ENTRIES,
	QUEUE_WAITING_MAX_TOMBSTONES,
	queueMembershipAgentSchema,
	queueMembershipSchema,
	queueResumeTombstoneSchema,
	queueWaitingEntrySchema,
	queueWaitingRecordSchema,
} from "./queue-state";

/**
 * The ACD KV value contracts.
 *
 * These are the shapes `apps/api` writes and `apps/engine` reads. The assertions that matter are
 * the ones a hand-written roster would get wrong — a missing dial string, a level of zero, a
 * timestamp that is not ISO — because the reader's only alternative to rejecting them is
 * distributing a caller to an endpoint it made up.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000q1".replace("q", "a");
const AGENT = "0195c0f0-1c2f-7000-8000-0000000000b1";

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agentId: AGENT,
		name: "Ada",
		contactKind: "extension",
		contact: "PJSIP/1001",
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

function membership(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		orgId: ORG,
		queueId: QUEUE,
		wrapUpSeconds: 10,
		tierRulesApply: true,
		tierRuleWaitSeconds: 30,
		tierRuleNoAgentNoWait: false,
		agents: [agent()],
		updatedAt: "2026-08-05T12:00:00.000Z",
		...overrides,
	};
}

describe("queueMembershipSchema", () => {
	it("accepts a roster the control plane would write", () => {
		const parsed = queueMembershipSchema.parse(membership({ name: "Support", revision: 7 }));
		expect(parsed.agents).toHaveLength(1);
		expect(parsed.agents[0]?.contact).toBe("PJSIP/1001");
		expect(parsed.revision).toBe(7);
	});

	it("accepts an empty roster: a queue with nobody in it is a real configuration", () => {
		expect(queueMembershipSchema.parse(membership({ agents: [] })).agents).toEqual([]);
	});

	it("rejects an agent with no dial string", () => {
		expect(() =>
			queueMembershipSchema.parse(membership({ agents: [agent({ contact: "" })] })),
		).toThrow();
	});

	it("rejects a level below 1, so tier ordering can never be ambiguous", () => {
		expect(() => queueMembershipAgentSchema.parse(agent({ level: 0 }))).toThrow();
	});

	it("rejects a non-ISO updatedAt", () => {
		expect(() => queueMembershipSchema.parse(membership({ updatedAt: "yesterday" }))).toThrow();
	});

	it("rejects an external agent whose contact is missing rather than defaulting it", () => {
		expect(() =>
			queueMembershipAgentSchema.parse({
				...agent({ contactKind: "external" }),
				contact: undefined,
			}),
		).toThrow();
	});

	it("caps the roster so one queue cannot fill the bucket's value limit", () => {
		const agents = Array.from({ length: 501 }, () => agent());
		expect(() => queueMembershipSchema.parse(membership({ agents }))).toThrow();
	});
});

describe("agentStateEntrySchema", () => {
	it("accepts the minimum an engine writes", () => {
		const parsed = agentStateEntrySchema.parse({
			orgId: ORG,
			agentId: AGENT,
			status: "available",
			since: "2026-08-05T12:00:00.000Z",
		});
		expect(parsed.status).toBe("available");
		expect(parsed.availableAt).toBeUndefined();
	});

	it("carries a wrap-up deadline independently of the status", () => {
		const parsed = agentStateEntrySchema.parse({
			orgId: ORG,
			agentId: AGENT,
			status: "wrap-up",
			previousStatus: "on-call",
			since: "2026-08-05T12:00:00.000Z",
			availableAt: "2026-08-05T12:00:10.000Z",
			noAnswerCount: 0,
			source: "engine",
		});
		expect(parsed.availableAt).toBe("2026-08-05T12:00:10.000Z");
		expect(parsed.previousStatus).toBe("on-call");
	});

	it("rejects a status outside the telephony vocabulary", () => {
		expect(() =>
			agentStateEntrySchema.parse({
				orgId: ORG,
				agentId: AGENT,
				status: "coffee",
				since: "2026-08-05T12:00:00.000Z",
			}),
		).toThrow();
	});
});

describe("the queue-membership bucket", () => {
	it("is registered so a boot that applies definitions creates it", () => {
		expect(KV_BUCKETS).toContain(QUEUE_MEMBERSHIP_KV);
	});

	it("never expires: a roster is configuration, and an expiring one is an outage on a timer", () => {
		expect(QUEUE_MEMBERSHIP_KV.ttlMs).toBe(0);
	});

	it("keys one entry per queue, organization first", () => {
		expect(kvKeyFor.queueMembership(ORG, QUEUE)).toBe(`${ORG}.${QUEUE}`);
	});

	it("refuses a key token that would break the subject grammar", () => {
		expect(() => kvKeyFor.queueMembership(ORG, "queue.with.dots")).toThrow();
		expect(() => kvKeyFor.queueMembership("", QUEUE)).toThrow();
	});
});

/**
 * The waiting line.
 *
 * What is asserted here is the half a hand-written record would get wrong in a way no reader could
 * detect: a priority outside the event's scale (a wallboard would render a bar off the end of its
 * axis), a timestamp written as an ISO string because the rest of the file uses them (every
 * comparison against it becomes `NaN`, and `NaN >= x` is false, so a lease would never expire and a
 * dead instance's callers would sit in the line for ever), and an unbounded array.
 */
describe("the queue-waiting bucket", () => {
	const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
	const LEG = "0195c0f0-1c2f-7000-8000-0000000000d1";

	function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			callId: CALL,
			legId: LEG,
			priority: 0,
			joinedAt: 1_754_395_200_000,
			instanceId: "engine-1",
			expiresAt: 1_754_395_290_000,
			...overrides,
		};
	}

	it("is registered so a boot that applies definitions creates it", () => {
		expect(KV_BUCKETS).toContain(QUEUE_WAITING_KV);
	});

	/**
	 * The opposite decision from `queue-membership`, one line above it in `KV_BUCKETS`, and the
	 * contrast is the reason both are asserted: a roster is configuration and an expiring one is an
	 * outage produced by a timer, while a line is live state and a line nobody is joining should
	 * evaporate.
	 */
	it("expires, unlike the roster it shares a key shape with", () => {
		expect(QUEUE_WAITING_KV.ttlMs).toBeGreaterThan(0);
		expect(QUEUE_MEMBERSHIP_KV.ttlMs).toBe(0);
	});

	it("accepts a full line with tombstones", () => {
		const parsed = queueWaitingRecordSchema.parse({
			orgId: ORG,
			queueId: QUEUE,
			entries: [entry(), entry({ callId: LEG, priority: 500 })],
			tombstones: [
				{
					callerNumber: "+15551234567",
					joinedAt: 1_754_395_100_000,
					priority: 500,
					abandonedAt: 1_754_395_150_000,
					expiresAt: 1_754_395_210_000,
				},
			],
			updatedAt: 1_754_395_200_000,
		});
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.tombstones[0]?.callerNumber).toBe("+15551234567");
	});

	it("takes epoch millis and refuses the ISO strings the rest of this file uses", () => {
		expect(() =>
			queueWaitingEntrySchema.parse(entry({ joinedAt: "2026-08-05T12:00:00.000Z" })),
		).toThrow();
		expect(() =>
			queueWaitingEntrySchema.parse(entry({ expiresAt: "2026-08-05T12:01:30.000Z" })),
		).toThrow();
	});

	it("holds priority to the same 0-1000 scale the joined event publishes on", () => {
		expect(queueWaitingEntrySchema.parse(entry({ priority: 1000 })).priority).toBe(1000);
		expect(() => queueWaitingEntrySchema.parse(entry({ priority: 1001 }))).toThrow();
		expect(() => queueWaitingEntrySchema.parse(entry({ priority: -1 }))).toThrow();
	});

	/** A caller with no number gets no promise: see the schema note on who else would collect it. */
	it("refuses a tombstone with no caller number to key it on", () => {
		expect(() =>
			queueResumeTombstoneSchema.parse({
				callerNumber: "",
				joinedAt: 1,
				priority: 0,
				abandonedAt: 1,
				expiresAt: 2,
			}),
		).toThrow();
	});

	it("caps both arrays below what the bucket's value size would accept", () => {
		const one = entry();
		expect(() =>
			queueWaitingRecordSchema.parse({
				orgId: ORG,
				queueId: QUEUE,
				entries: Array.from({ length: QUEUE_WAITING_MAX_ENTRIES + 1 }, () => one),
				tombstones: [],
				updatedAt: 1,
			}),
		).toThrow();
		expect(QUEUE_WAITING_MAX_ENTRIES).toBeLessThanOrEqual(QUEUE_WAITING_MAX_TOMBSTONES);
	});
});
