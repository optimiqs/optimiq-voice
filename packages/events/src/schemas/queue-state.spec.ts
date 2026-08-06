import { describe, expect, it } from "bun:test";
import { KV_BUCKETS, kvKeyFor, QUEUE_MEMBERSHIP_KV } from "../streams";
import {
	agentStateEntrySchema,
	queueMembershipAgentSchema,
	queueMembershipSchema,
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
