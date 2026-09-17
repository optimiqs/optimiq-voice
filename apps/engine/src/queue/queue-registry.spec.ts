import { describe, expect, it } from "bun:test";
import { QueueCursors } from "./queue-registry";

/**
 * The round-robin cursor.
 *
 * The line that used to be tested beside it moved to the backbone; its cases live in
 * `queue-waiting.spec.ts` now, over the same shape of assertions plus the ones a shared record makes
 * possible (priority, leases, tombstones).
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";
const QUEUE = "q1";
const OTHER_QUEUE = "q2";

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
