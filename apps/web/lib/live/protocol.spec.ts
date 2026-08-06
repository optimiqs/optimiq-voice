import { describe, expect, it } from "bun:test";
import {
	LIVE_CLOSE_POLICY,
	LIVE_PATH,
	LIVE_TOPIC_KINDS,
	liveSocketUrl,
	parseServerFrame,
	queueTopic,
	reconnectDelayMs,
	shouldReconnect,
	topicKind,
} from "./protocol";

/**
 * The client half of the live protocol, checked against the server's own constants.
 *
 * The imports from `apps/api` are what make this a CONTRACT rather than a copy: the mirror is
 * hand-written because there is no OpenAPI generator yet, and a hand-written mirror nobody compares
 * is a file that drifts on the first server change.
 */

describe("the mirror", () => {
	it("agrees with the server about the path", async () => {
		const server = await import("../../../api/src/live/live-protocol");
		expect(LIVE_PATH).toBe(server.LIVE_PATH);
	});

	it("agrees with the server about the topic vocabulary", async () => {
		const server = await import("../../../api/src/live/live-topics");
		expect([...LIVE_TOPIC_KINDS].sort()).toEqual([...server.LIVE_TOPIC_KINDS].sort());
	});

	it("agrees with the server about the policy close code", async () => {
		const server = await import("../../../api/src/live/live-protocol");
		expect(LIVE_CLOSE_POLICY).toBe(server.LIVE_CLOSE_POLICY);
	});
});

describe("queueTopic", () => {
	it("round-trips through topicKind", () => {
		expect(topicKind(queueTopic("019fd3c2-1111-76be-a6b3-b0f1914e39b6"))).toBe("queue");
		expect(topicKind("registrations")).toBe("registrations");
		expect(topicKind("active-calls")).toBe("active-calls");
		expect(topicKind("agent-state")).toBe("agent-state");
	});
});

describe("parseServerFrame", () => {
	it("narrows a frame this build understands", () => {
		const frame = parseServerFrame(
			JSON.stringify({ op: "snapshot", topic: "registrations", at: "t", data: [] }),
		);
		expect(frame?.op).toBe("snapshot");
	});

	/**
	 * The forward-compatibility half of the contract. The server ships independently of the tab
	 * that happens to be open, and a client that threw on a new frame type would turn every additive
	 * server release into a broken dashboard for everyone who had not reloaded.
	 */
	it("ignores an op it has never heard of rather than throwing", () => {
		expect(parseServerFrame(JSON.stringify({ op: "telemetry", data: 1 }))).toBe(undefined);
	});

	it("ignores anything that is not a JSON object", () => {
		for (const raw of ["", "not json", "[]", "null", '"welcome"', "7"]) {
			expect(parseServerFrame(raw), raw).toBe(undefined);
		}
	});
});

describe("liveSocketUrl", () => {
	it("uses the page's own origin, so the session cookie stays first-party", () => {
		expect(liveSocketUrl("http://localhost:3100")).toBe("ws://localhost:3100/api/v1/live");
	});

	/** A `ws://` socket opened from an `https://` page is blocked as mixed content everywhere. */
	it("upgrades to wss on a secure page", () => {
		expect(liveSocketUrl("https://app.example.com")).toBe("wss://app.example.com/api/v1/live");
	});

	it("keeps a non-default port", () => {
		expect(liveSocketUrl("https://app.example.com:8443")).toBe(
			"wss://app.example.com:8443/api/v1/live",
		);
	});
});

describe("reconnectDelayMs", () => {
	it("grows and then caps", () => {
		const noJitter = () => 0.5;
		expect(reconnectDelayMs(0, noJitter)).toBe(500);
		expect(reconnectDelayMs(1, noJitter)).toBe(1_000);
		expect(reconnectDelayMs(5, noJitter)).toBe(15_000);
		expect(reconnectDelayMs(50, noJitter)).toBe(15_000);
	});

	/**
	 * Every tab in an organization loses its socket in the same instant when the API restarts, and
	 * a deterministic backoff reconnects all of them in the same millisecond — a thundering herd
	 * against a process that has just started.
	 */
	it("spreads reconnects so a restart is a ramp rather than a spike", () => {
		expect(reconnectDelayMs(3, () => 0)).toBeLessThan(reconnectDelayMs(3, () => 1));
	});

	it("never busy-loops, whatever the jitter draws", () => {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			expect(reconnectDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(250);
		}
	});
});

describe("shouldReconnect", () => {
	/**
	 * A policy close means the session ended or the organization changed. Reconnecting would open a
	 * socket refused for the same reason, forever, at increasing volume.
	 */
	it("stops after a policy close", () => {
		expect(shouldReconnect(LIVE_CLOSE_POLICY)).toBe(false);
	});

	it("retries after a server restart or a dropped link", () => {
		expect(shouldReconnect(1001)).toBe(true);
		expect(shouldReconnect(1006)).toBe(true);
	});
});
