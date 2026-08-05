import { describe, expect, it } from "bun:test";
import { AriEventStream } from "./event-stream";
import type { AriEventGap, AriStreamStatus } from "./event-stream";
import type { AriEvent } from "./events";

/**
 * A WebSocket double. Only the four handler properties and `close` are implemented, because that
 * is the whole of the WHATWG surface `AriEventStream` uses — anything more would be testing the
 * double rather than the stream.
 */
class FakeSocket {
	static readonly instances: FakeSocket[] = [];

	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	closedWith: { code: number; reason: string } | undefined;

	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}

	open(): void {
		this.onopen?.({});
	}

	deliver(payload: unknown): void {
		this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
	}

	fail(code = 1006, reason = "abnormal"): void {
		this.onclose?.({ code, reason });
	}

	close(code: number, reason: string): void {
		this.closedWith = { code, reason };
	}
}

function stasisStart(channelId: string): Record<string, unknown> {
	return {
		type: "StasisStart",
		application: "optimiq-engine",
		args: [],
		channel: { id: channelId, name: "PJSIP/x", state: "Ring" },
	};
}

interface Harness {
	readonly stream: AriEventStream;
	readonly events: AriEvent[];
	readonly errors: unknown[];
	readonly statuses: AriStreamStatus[];
	readonly gaps: AriEventGap[];
	readonly sockets: FakeSocket[];
	readonly clock: { value: number };
}

function harness(): Harness {
	FakeSocket.instances.length = 0;
	const events: AriEvent[] = [];
	const errors: unknown[] = [];
	const statuses: AriStreamStatus[] = [];
	const gaps: AriEventGap[] = [];
	const clock = { value: 1_000 };

	const stream = new AriEventStream({
		url: "ws://asterisk:8088/ari/events?app=optimiq-engine&api_key=ari%3Asecret",
		// A 1ms floor keeps the reconnect scheduling real without making the spec slow.
		backoff: { baseMs: 1, factor: 1, maxMs: 1, jitter: 0 },
		handlers: {
			onEvent: (event) => events.push(event),
			onError: (error) => errors.push(error),
			onStatusChange: (status) => statuses.push(status),
			onGap: (gap) => gaps.push(gap),
		},
		webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
		now: () => clock.value,
	});

	return { stream, events, errors, statuses, gaps, sockets: FakeSocket.instances, clock };
}

async function startAndOpen(h: Harness): Promise<void> {
	const started = h.stream.start();
	await Promise.resolve();
	h.sockets[h.sockets.length - 1]?.open();
	await started;
}

/** Lets the reconnect timer (1ms) fire and the new socket be constructed. */
async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("AriEventStream", () => {
	it("starts idle and reports open once the socket opens", async () => {
		const h = harness();
		expect(h.stream.status).toBe("idle");
		expect(h.stream.isOpen).toBe(false);

		await startAndOpen(h);

		expect(h.stream.status).toBe("open");
		expect(h.stream.isOpen).toBe(true);
		expect(h.statuses).toEqual(["connecting", "open"]);
		h.stream.close();
	});

	it("delivers parsed, typed events", async () => {
		const h = harness();
		await startAndOpen(h);

		h.sockets[0]?.deliver(stasisStart("1754400000.1"));

		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.type).toBe("StasisStart");
		expect(h.stream.eventCount).toBe(1);
		h.stream.close();
	});

	it("drops a poison frame and reports it instead of throwing out of the callback", async () => {
		const h = harness();
		await startAndOpen(h);

		h.sockets[0]?.deliver("{not json");
		h.sockets[0]?.deliver(stasisStart("1754400000.2"));

		expect(h.errors).toHaveLength(1);
		expect(h.events).toHaveLength(1);
		expect(h.stream.status).toBe("open");
		h.stream.close();
	});

	it("reports a throwing handler without tearing the socket down", async () => {
		FakeSocket.instances.length = 0;
		const errors: unknown[] = [];
		const stream = new AriEventStream({
			url: "ws://asterisk:8088/ari/events",
			handlers: {
				onEvent: () => {
					throw new Error("handler blew up");
				},
				onError: (error) => errors.push(error),
			},
			webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
		});

		const started = stream.start();
		await Promise.resolve();
		FakeSocket.instances[0]?.open();
		await started;
		FakeSocket.instances[0]?.deliver(stasisStart("1754400000.3"));

		expect(errors).toHaveLength(1);
		expect(stream.status).toBe("open");
		stream.close();
	});

	it("rejects start() when the first connection never opens, so a bad config fails fast", async () => {
		const h = harness();
		const started = h.stream.start();
		await Promise.resolve();
		h.sockets[0]?.fail(1006, "connection refused");
		await expect(started).rejects.toThrow(/closed before it opened/u);
		h.stream.close();
	});

	it("reconnects after a drop and reports the gap", async () => {
		const h = harness();
		await startAndOpen(h);
		h.sockets[0]?.deliver(stasisStart("1754400000.4"));

		h.clock.value = 5_000;
		h.sockets[0]?.fail();
		expect(h.stream.status).toBe("reconnecting");

		await tick();
		h.clock.value = 5_400;
		h.sockets[1]?.open();

		expect(h.stream.status).toBe("open");
		expect(h.gaps).toHaveLength(1);
		expect(h.gaps[0]).toMatchObject({
			disconnectedAt: 5_000,
			reconnectedAt: 5_400,
			downtimeMs: 400,
			eventsBeforeGap: 1,
			attempts: 1,
		});
		h.stream.close();
	});

	it("counts events across reconnects but resets the per-session count", async () => {
		const h = harness();
		await startAndOpen(h);
		h.sockets[0]?.deliver(stasisStart("a"));
		h.sockets[0]?.deliver(stasisStart("b"));
		h.sockets[0]?.fail();
		await tick();
		h.sockets[1]?.open();
		h.sockets[1]?.deliver(stasisStart("c"));

		expect(h.stream.eventCount).toBe(3);
		expect(h.gaps[0]?.eventsBeforeGap).toBe(2);
		h.stream.close();
	});

	it("does not reconnect after close() and closes with a normal code", async () => {
		const h = harness();
		await startAndOpen(h);
		const socketCount = h.sockets.length;

		h.stream.close();
		await tick();

		expect(h.stream.status).toBe("closed");
		expect(h.sockets).toHaveLength(socketCount);
		expect(h.sockets[0]?.closedWith?.code).toBe(1000);
	});

	it("is idempotent on close", async () => {
		const h = harness();
		await startAndOpen(h);
		h.stream.close();
		h.stream.close();
		expect(h.stream.status).toBe("closed");
	});

	it("never exposes the credential in its loggable URL", () => {
		const h = harness();
		expect(h.stream.redactedUrl).not.toContain("secret");
		expect(h.stream.redactedUrl).toContain("api_key=redacted");
	});
});
