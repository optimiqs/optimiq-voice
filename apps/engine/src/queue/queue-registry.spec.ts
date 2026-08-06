import { describe, expect, it } from "bun:test";
import { QueueCursors, QueuePositions } from "./queue-registry";

/**
 * The line and the cursor.
 *
 * Small enough that the cases read as a specification: who is where, what happens when somebody
 * leaves from the middle, and what a queue this process has never heard of reports.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";
const QUEUE = "q1";
const OTHER_QUEUE = "q2";

describe("the line", () => {
	it("gives the first caller position 1", () => {
		const line = new QueuePositions();
		expect(line.join(ORG, QUEUE, "call-1")).toBe(1);
	});

	it("counts arrivals in order", () => {
		const line = new QueuePositions();
		expect(line.join(ORG, QUEUE, "call-1")).toBe(1);
		expect(line.join(ORG, QUEUE, "call-2")).toBe(2);
		expect(line.join(ORG, QUEUE, "call-3")).toBe(3);
	});

	it("moves everybody up when a caller ahead of them leaves", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		line.join(ORG, QUEUE, "call-2");
		line.join(ORG, QUEUE, "call-3");
		line.leave(ORG, QUEUE, "call-1");
		expect(line.positionOf(ORG, QUEUE, "call-2")).toBe(1);
		expect(line.positionOf(ORG, QUEUE, "call-3")).toBe(2);
	});

	it("does not move anybody when a caller BEHIND them leaves", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		line.join(ORG, QUEUE, "call-2");
		line.leave(ORG, QUEUE, "call-2");
		expect(line.positionOf(ORG, QUEUE, "call-1")).toBe(1);
	});

	it("keeps a caller's place when they join twice", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		line.join(ORG, QUEUE, "call-2");
		expect(line.join(ORG, QUEUE, "call-1")).toBe(1);
	});

	it("reports 1 for a caller it has never heard of, because the event's floor is 1", () => {
		const line = new QueuePositions();
		expect(line.positionOf(ORG, QUEUE, "unknown")).toBe(1);
	});

	it("keeps queues separate", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		expect(line.join(ORG, OTHER_QUEUE, "call-2")).toBe(1);
	});

	it("keeps tenants separate even when their queue ids collide", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		expect(line.join(OTHER_ORG, QUEUE, "call-2")).toBe(1);
	});

	it("counts every waiting caller across every queue", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		line.join(ORG, OTHER_QUEUE, "call-2");
		expect(line.waitingCount).toBe(2);
	});

	it("forgets an empty queue rather than leaving an array behind per queue per hour", () => {
		const line = new QueuePositions();
		line.join(ORG, QUEUE, "call-1");
		line.leave(ORG, QUEUE, "call-1");
		expect(line.waitingCount).toBe(0);
	});

	it("ignores a leave for a caller who is not in the line", () => {
		const line = new QueuePositions();
		expect(() => {
			line.leave(ORG, QUEUE, "never-joined");
		}).not.toThrow();
	});
});

describe("the round-robin cursor", () => {
	it("has nothing to say before the first distribution", () => {
		expect(new QueueCursors().lastAgentFor(ORG, QUEUE)).toBeUndefined();
	});

	it("remembers the last agent per queue", () => {
		const cursors = new QueueCursors();
		cursors.remember(ORG, QUEUE, "agent-a");
		cursors.remember(ORG, OTHER_QUEUE, "agent-b");
		expect(cursors.lastAgentFor(ORG, QUEUE)).toBe("agent-a");
		expect(cursors.lastAgentFor(ORG, OTHER_QUEUE)).toBe("agent-b");
	});

	it("keeps tenants separate", () => {
		const cursors = new QueueCursors();
		cursors.remember(ORG, QUEUE, "agent-a");
		expect(cursors.lastAgentFor(OTHER_ORG, QUEUE)).toBeUndefined();
	});
});
