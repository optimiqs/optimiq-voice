import { describe, expect, it } from "bun:test";
import { LiveClient, type LiveSocket } from "./client";

/**
 * The socket manager, driven by a fake socket.
 *
 * The behaviours worth pinning are the ones a browser would only reveal under conditions that are
 * hard to reach by hand: two components wanting the same topic, a reconnect, and a close the client
 * must NOT retry.
 */

interface Harness {
	readonly client: LiveClient;
	readonly sockets: FakeSocket[];
	readonly latest: () => FakeSocket;
	readonly runTimers: () => void;
}

class FakeSocket implements LiveSocket {
	readonly sent: string[] = [];
	closed = false;
	onopen: ((this: unknown, event: unknown) => void) | null = null;
	onmessage: ((this: unknown, event: { data: unknown }) => void) | null = null;
	onclose: ((this: unknown, event: { code: number; reason?: string }) => void) | null = null;
	onerror: ((this: unknown, event: unknown) => void) | null = null;

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
	}

	open(): void {
		this.onopen?.call(this, {});
	}

	deliver(frame: Record<string, unknown>): void {
		this.onmessage?.call(this, { data: JSON.stringify(frame) });
	}

	remoteClose(code: number): void {
		this.closed = true;
		this.onclose?.call(this, { code });
	}

	/** Every `op` this socket was sent, in order. */
	ops(): string[] {
		return this.sent.map((raw) => (JSON.parse(raw) as { op: string }).op);
	}

	frames(): Record<string, unknown>[] {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}
}

function harness(): Harness {
	const sockets: FakeSocket[] = [];
	const timers: (() => void)[] = [];
	const client = new LiveClient({
		origin: "http://localhost:3100",
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		setTimeoutFn: (handler) => {
			timers.push(handler);
			return timers.length;
		},
		clearTimeoutFn: () => undefined,
		random: () => 0.5,
	});
	return {
		client,
		sockets,
		latest: () => sockets[sockets.length - 1] as FakeSocket,
		runTimers: () => {
			const pending = [...timers];
			timers.length = 0;
			for (const run of pending) {
				run();
			}
		},
	};
}

describe("LiveClient", () => {
	/**
	 * Connecting lazily is what keeps the socket off pages that are ordinary CRUD. A connection
	 * costs the server a session resolution and a heartbeat, and most of this app is not live.
	 */
	it("opens no socket until something takes a lease", () => {
		const h = harness();
		expect(h.sockets).toHaveLength(0);
		h.client.subscribe("registrations", {});
		expect(h.sockets).toHaveLength(1);
	});

	it("subscribes once the socket is open, not before", () => {
		const h = harness();
		h.client.subscribe("registrations", {});
		h.latest().open();
		expect(h.latest().ops()).toContain("subscribe");
	});

	/**
	 * A reconnect is a NEW server-side connection that knows nothing about this client, so the whole
	 * topic set has to be re-sent — not just the ones added since.
	 */
	it("re-sends every topic after a reconnect", () => {
		const h = harness();
		h.client.subscribe("registrations", {});
		h.client.subscribe("agent-state", {});
		h.latest().open();

		h.latest().remoteClose(1006);
		h.runTimers();
		expect(h.sockets).toHaveLength(2);
		h.latest().open();

		const subscribed = h
			.latest()
			.frames()
			.find((frame) => frame.op === "subscribe");
		expect(subscribed?.topics).toEqual(["registrations", "agent-state"]);
	});

	/**
	 * A policy close means the session ended or the organization changed. Retrying would open a
	 * socket refused for the same reason, forever, at increasing volume.
	 */
	it("stops reconnecting after a policy close, and says so", () => {
		const h = harness();
		h.client.subscribe("registrations", {});
		h.latest().open();
		h.latest().remoteClose(1008);
		h.runTimers();
		expect(h.sockets).toHaveLength(1);
		expect(h.client.status).toBe("refused");
	});

	it("holds one lease per subscriber and unsubscribes only on the last", () => {
		const h = harness();
		const first = h.client.subscribe("registrations", {});
		const second = h.client.subscribe("registrations", {});
		h.latest().open();
		h.latest().sent.length = 0;

		first();
		expect(h.latest().ops()).not.toContain("unsubscribe");
		second();
		expect(h.latest().ops()).toContain("unsubscribe");
	});

	/** Holding the socket open for a page that is not watching keeps a server heartbeat alive. */
	it("closes the socket when the last lease goes", () => {
		const h = harness();
		const release = h.client.subscribe("registrations", {});
		h.latest().open();
		release();
		expect(h.latest().closed).toBe(true);
	});

	it("is idempotent when a release runs twice", () => {
		const h = harness();
		const release = h.client.subscribe("registrations", {});
		h.latest().open();
		release();
		release();
		expect(h.latest().ops().filter((op) => op === "unsubscribe")).toHaveLength(1);
	});

	it("routes a snapshot to the topic that asked for it, and to nobody else", () => {
		const h = harness();
		const registrations: unknown[] = [];
		const agents: unknown[] = [];
		h.client.subscribe("registrations", { onSnapshot: (event) => registrations.push(event) });
		h.client.subscribe("agent-state", { onSnapshot: (event) => agents.push(event) });
		h.latest().open();
		h.latest().deliver({ op: "snapshot", topic: "registrations", at: "t", data: [] });
		expect(registrations).toHaveLength(1);
		expect(agents).toHaveLength(0);
	});

	it("routes an event with its key intact, which a delete has nothing else to be identified by", () => {
		const h = harness();
		const seen: { key?: string; kind: string }[] = [];
		h.client.subscribe("registrations", {
			onUpdate: (event) => seen.push({ kind: event.kind, ...(event.key === undefined ? {} : { key: event.key }) }),
		});
		h.latest().open();
		h.latest().deliver({
			op: "event",
			topic: "registrations",
			kind: "delete",
			at: "t",
			data: null,
			key: "org.aaaa",
		});
		expect(seen).toEqual([{ kind: "delete", key: "org.aaaa" }]);
	});

	it("reports a denied topic to the component that asked for it", () => {
		const h = harness();
		const denied: unknown[] = [];
		h.client.subscribe("registrations", { onDenied: (event) => denied.push(event) });
		h.latest().open();
		h.latest().deliver({
			op: "subscribed",
			topics: [],
			denied: [{ topic: "registrations", reason: "forbidden", permission: "extensions.read" }],
		});
		expect(denied).toHaveLength(1);
	});

	it("remembers what the welcome frame said this session may watch", () => {
		const h = harness();
		h.client.subscribe("registrations", {});
		h.latest().open();
		h.latest().deliver({
			op: "welcome",
			orgId: "org",
			topics: ["agent-state", "queue"],
			heartbeatMs: 25_000,
			at: "t",
		});
		expect(h.client.allowedTopicKinds).toEqual(["agent-state", "queue"]);
	});

	/** A frame this build does not understand must not take the socket — or a render — down. */
	it("ignores an unknown frame", () => {
		const h = harness();
		h.client.subscribe("registrations", {});
		h.latest().open();
		expect(() => h.latest().deliver({ op: "telemetry", value: 1 })).not.toThrow();
		expect(() => h.latest().onmessage?.call(null, { data: "not json" })).not.toThrow();
	});

	it("closes everything on destroy and does not reconnect afterwards", () => {
		const h = harness();
		h.client.subscribe("registrations", {});
		h.latest().open();
		h.client.destroy();
		expect(h.latest().closed).toBe(true);
		h.runTimers();
		expect(h.sockets).toHaveLength(1);
	});
});
