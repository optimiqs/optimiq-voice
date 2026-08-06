import { expect } from "chai";
import {
	LIVE_HEARTBEAT_MS,
	LIVE_HEARTBEAT_TIMEOUT_MS,
	LIVE_MAX_FRAME_BYTES,
	LIVE_MAX_TOPICS_PER_CONNECTION,
	LIVE_PATH,
	parseClientFrame,
} from "../../src/live/live-protocol";

/**
 * The client → server frame parser.
 *
 * A WebSocket is an authenticated caller sending arbitrary bytes for as long as the connection
 * lives, which is a much longer window than any HTTP request. So the property worth asserting is
 * that a hostile or broken frame produces a REASON rather than an exception: a throw inside the
 * message handler would take down a socket that other tabs' users are watching, or — with an
 * unhandled rejection — the process.
 */

describe("parseClientFrame", () => {
	it("accepts a subscribe with topics", () => {
		const result = parseClientFrame(JSON.stringify({ op: "subscribe", topics: ["registrations"] }));
		expect(result.frame?.op).to.equal("subscribe");
		expect(result.reason).to.equal("");
	});

	it("carries the correlation id through untouched", () => {
		const result = parseClientFrame(
			JSON.stringify({ op: "subscribe", topics: ["agent-state"], id: "abc" }),
		);
		expect(result.frame).to.deep.equal({ op: "subscribe", topics: ["agent-state"], id: "abc" });
	});

	it("accepts unsubscribe and ping", () => {
		expect(parseClientFrame(JSON.stringify({ op: "unsubscribe", topics: ["x"] })).frame?.op).to.equal(
			"unsubscribe",
		);
		expect(parseClientFrame(JSON.stringify({ op: "ping" })).frame?.op).to.equal("ping");
	});

	it("rejects a frame that is not JSON, without throwing", () => {
		const result = parseClientFrame("not json at all");
		expect(result.frame).to.equal(undefined);
		expect(result.reason).to.contain("JSON");
	});

	it("rejects an unknown op", () => {
		const result = parseClientFrame(JSON.stringify({ op: "shutdown" }));
		expect(result.frame).to.equal(undefined);
	});

	/**
	 * `strictObject`, so a typo'd key is a value the caller believes they sent and the server
	 * silently dropped. On a socket that mistake would be permanent for the life of the connection.
	 */
	it("rejects an unknown key rather than dropping it", () => {
		const result = parseClientFrame(
			JSON.stringify({ op: "subscribe", topics: ["registrations"], orgId: "someone-elses" }),
		);
		expect(result.frame).to.equal(undefined);
	});

	it("rejects an empty topic list", () => {
		expect(parseClientFrame(JSON.stringify({ op: "subscribe", topics: [] })).frame).to.equal(
			undefined,
		);
	});

	it("rejects more topics than a connection may hold", () => {
		const topics = Array.from({ length: LIVE_MAX_TOPICS_PER_CONNECTION + 1 }, (_, index) =>
			String(index),
		);
		expect(parseClientFrame(JSON.stringify({ op: "subscribe", topics })).frame).to.equal(undefined);
	});

	/** Checked before `JSON.parse`, so an enormous frame is not parsed to find out it is enormous. */
	it("rejects an oversized frame by length, not by parsing it", () => {
		const huge = JSON.stringify({ op: "subscribe", topics: ["x".repeat(LIVE_MAX_FRAME_BYTES)] });
		const result = parseClientFrame(huge);
		expect(result.frame).to.equal(undefined);
		expect(result.reason).to.contain("bytes");
	});

	it("rejects a JSON array, a string and a null", () => {
		for (const raw of ["[]", '"subscribe"', "null", "42"]) {
			expect(parseClientFrame(raw).frame, raw).to.equal(undefined);
		}
	});
});

describe("the protocol constants", () => {
	it("mounts under the versioned API path, so the web proxy's /api rule covers it", () => {
		expect(LIVE_PATH).to.equal("/api/v1/live");
	});

	/** Two missed pings, plus slack. A timeout shorter than the interval reaps healthy sockets. */
	it("gives a socket more than one heartbeat to answer", () => {
		expect(LIVE_HEARTBEAT_TIMEOUT_MS).to.be.greaterThan(LIVE_HEARTBEAT_MS * 2);
	});

	/** Inside the 60 s idle timeout most proxies and load balancers apply. */
	it("pings well inside a typical proxy idle timeout", () => {
		expect(LIVE_HEARTBEAT_MS).to.be.lessThan(60_000);
	});
});
