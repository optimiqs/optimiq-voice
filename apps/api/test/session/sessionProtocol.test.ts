import { expect } from "chai";
import {
	parseSessionFrame,
	SESSION_HEARTBEAT_MS,
	SESSION_HEARTBEAT_TIMEOUT_MS,
	SESSION_MAX_APPLICATIONS,
	SESSION_MAX_FRAME_BYTES,
	SESSION_PATH,
} from "../../src/session/session-protocol";

/**
 * The client → server frame parser for the CONTROL channel.
 *
 * The live channel's parser has the same shape and the assertions here are deliberately its
 * assertions plus one class: this socket can hang a call up, so a frame that is nearly right must be
 * refused rather than coerced. A `verb` naming something the engine does not implement is caught by
 * the schema, not by a call that is already in progress; an application name carrying a NATS
 * wildcard is refused at the edge, where the client can be told, rather than hashed away silently.
 */

describe("parseSessionFrame", () => {
	it("accepts a claim, a release, a verb and a ping", () => {
		expect(
			parseSessionFrame(JSON.stringify({ op: "claim", applications: ["crm"] })).frame?.op,
		).to.equal("claim");
		expect(
			parseSessionFrame(JSON.stringify({ op: "release", applications: ["crm"] })).frame?.op,
		).to.equal("release");
		expect(
			parseSessionFrame(JSON.stringify({ op: "verb", sessionId: "s-1", verb: "answer" })).frame?.op,
		).to.equal("verb");
		expect(parseSessionFrame(JSON.stringify({ op: "ping" })).frame?.op).to.equal("ping");
	});

	it("carries the correlation id through untouched", () => {
		const result = parseSessionFrame(
			JSON.stringify({ op: "verb", sessionId: "s-1", verb: "hangup", id: "abc" }),
		);
		expect(result.frame).to.deep.equal({ op: "verb", sessionId: "s-1", verb: "hangup", id: "abc" });
	});

	it("rejects a frame that is not JSON, without throwing", () => {
		const result = parseSessionFrame("not json at all");
		expect(result.frame).to.equal(undefined);
		expect(result.reason).to.contain("JSON");
	});

	it("rejects an unknown op", () => {
		expect(parseSessionFrame(JSON.stringify({ op: "shutdown" })).frame).to.equal(undefined);
	});

	/**
	 * The wire refuses a verb the executor does not implement. An application gets the refusal from
	 * its own schema validation, immediately, rather than from a call that is already up.
	 */
	it("rejects a verb the engine does not implement", () => {
		const result = parseSessionFrame(
			JSON.stringify({ op: "verb", sessionId: "s-1", verb: "say", arguments: { name: "hi" } }),
		);
		expect(result.frame).to.equal(undefined);
	});

	it("validates verb arguments against the engine's own schema", () => {
		expect(
			parseSessionFrame(
				JSON.stringify({
					op: "verb",
					sessionId: "s-1",
					verb: "gather",
					arguments: { maxDigits: 4, terminators: ["##"] },
				}),
			).frame,
		).to.equal(undefined);
		expect(
			parseSessionFrame(
				JSON.stringify({
					op: "verb",
					sessionId: "s-1",
					verb: "gather",
					arguments: { maxDigits: 4, terminators: ["#"] },
				}),
			).frame?.op,
		).to.equal("verb");
	});

	/**
	 * An application name becomes a NATS subject token. A `>` in one would be a wildcard subscription
	 * across a whole subject tree if anything downstream ever stopped hashing it.
	 */
	it("refuses an application name carrying a wildcard", () => {
		for (const application of ["*", ">", "crm.>", "*.crm", ""]) {
			expect(
				parseSessionFrame(JSON.stringify({ op: "claim", applications: [application] })).frame,
				application,
			).to.equal(undefined);
		}
	});

	it("accepts the application names a tenant would actually type", () => {
		const result = parseSessionFrame(
			JSON.stringify({ op: "claim", applications: ["crm-screenpop", "Sales IVR", "autopilot_2"] }),
		);
		expect(result.frame?.op).to.equal("claim");
	});

	it("caps the number of applications one socket may claim at once", () => {
		const many = Array.from(
			{ length: SESSION_MAX_APPLICATIONS + 1 },
			(_, at) => `app${String(at)}`,
		);
		expect(parseSessionFrame(JSON.stringify({ op: "claim", applications: many })).frame).to.equal(
			undefined,
		);
	});

	/**
	 * `strictObject`, so a typo'd key is a value the caller believes they sent and the server silently
	 * dropped. On a control socket that mistake would be a verb that did not do what was asked.
	 */
	it("rejects an unknown key rather than dropping it", () => {
		const result = parseSessionFrame(
			JSON.stringify({ op: "verb", sessionId: "s-1", verb: "answer", legId: "someone-elses" }),
		);
		expect(result.frame).to.equal(undefined);
	});

	it("rejects an oversized frame by size, before parsing it", () => {
		const result = parseSessionFrame("x".repeat(SESSION_MAX_FRAME_BYTES + 1));
		expect(result.frame).to.equal(undefined);
		expect(result.reason).to.contain("exceed");
	});
});

describe("session protocol constants", () => {
	it("mounts on its own path, beside the live channel rather than inside it", () => {
		expect(SESSION_PATH).to.equal("/api/v1/session");
	});

	it("reaps a socket only after two missed heartbeats", () => {
		expect(SESSION_HEARTBEAT_TIMEOUT_MS).to.be.greaterThan(SESSION_HEARTBEAT_MS * 2);
	});
});
