import { describe, expect, it } from "bun:test";
import { of } from "rxjs";
import { QueueEventPublisher } from "./queue-event-publisher.service";
import type { ClientProxy } from "@nestjs/microservices";

/**
 * What the ACD events actually carry.
 *
 * The envelope and the subject are `packages/events`' business and are built here through the real
 * `makeQueueEvent`, so what these cover is the one thing this class decides: which of the fields the
 * session hands it survive into the payload. A field the schema accepts and the publisher drops is
 * invisible everywhere else — the port's types are method parameters, and TypeScript's bivariance
 * lets a narrower one satisfy the interface.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const LEG = "0195c0f0-1c2f-7000-8000-0000000000a1";

function harness() {
	const emitted: { subject: string; envelope: Record<string, unknown> }[] = [];
	const client = {
		emit: (subject: string, envelope: Record<string, unknown>) => {
			emitted.push({ subject, envelope });
			return of(undefined);
		},
	} as unknown as ClientProxy;
	return { publisher: new QueueEventPublisher(client), emitted };
}

function dataOf(h: ReturnType<typeof harness>): Record<string, unknown> {
	const envelope = h.emitted[0]?.envelope as { data: Record<string, unknown> } | undefined;
	return envelope?.data ?? {};
}

describe("caller.joined", () => {
	it("carries `resumed`, so a restored caller is not read as a fresh arrival", async () => {
		const h = harness();
		await h.publisher.callerJoined({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			legId: LEG,
			position: 2,
			priority: 0,
			resumed: true,
		});
		expect(dataOf(h)).toMatchObject({ position: 2, resumed: true });
	});

	it("omits `resumed` for a caller who joined at the back", async () => {
		const h = harness();
		await h.publisher.callerJoined({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			legId: LEG,
			position: 1,
			priority: 0,
		});
		expect(dataOf(h)).not.toHaveProperty("resumed");
	});
});

describe("caller.abandoned", () => {
	it("carries the exit key and its reason", async () => {
		const h = harness();
		await h.publisher.callerAbandoned({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			legId: LEG,
			waitMs: 12_000,
			reason: "exit-key",
			exitKey: "9",
		});
		expect(dataOf(h)).toMatchObject({ reason: "exit-key", exitKey: "9" });
	});

	it("omits the position when the line was never readable", async () => {
		const h = harness();
		await h.publisher.callerAbandoned({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			legId: LEG,
			waitMs: 12_000,
			reason: "timeout",
		});
		expect(dataOf(h)).not.toHaveProperty("position");
	});
});
