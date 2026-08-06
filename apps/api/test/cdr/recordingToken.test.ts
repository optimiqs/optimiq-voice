import { expect } from "chai";
import {
	mintRecordingToken,
	recordingMediaPath,
	resolveRecordingObjectPath,
	verifyRecordingToken,
} from "../../src/cdr/recordings/recording-token";

/**
 * The token is the whole of the access control on an anonymous route, so these are not "does the
 * happy path work" tests — every one of them is a way the anonymous route could be opened.
 */

const KEY = "a".repeat(48);
const OTHER_KEY = "b".repeat(48);
const RECORDING = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function future(seconds = 300): number {
	return Math.floor(Date.now() / 1000) + seconds;
}

describe("recording download token", () => {
	it("round trips a valid token", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, KEY);
		const result = verifyRecordingToken(token, { current: KEY });

		expect(result.ok).to.equal(true);
		expect(result.payload?.r).to.equal(RECORDING);
		expect(result.payload?.o).to.equal(ORG);
	});

	it("refuses a token signed with another key", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, OTHER_KEY);
		const result = verifyRecordingToken(token, { current: KEY });

		expect(result.ok).to.equal(false);
		expect(result.failure).to.equal("bad-signature");
	});

	it("refuses a token whose payload was edited to name another recording", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, KEY);
		const [, signature] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({ r: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99", o: ORG, e: future() }),
			"utf8",
		).toString("base64url");

		const result = verifyRecordingToken(`${forged}.${String(signature)}`, { current: KEY });

		expect(result.ok).to.equal(false);
		expect(result.failure).to.equal("bad-signature");
	});

	it("refuses a token whose payload was edited to name another organization", () => {
		// The tenant scope the media read runs under comes from this field. It has to be signed.
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, KEY);
		const [, signature] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({ r: RECORDING, o: "0199ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b", e: future() }),
			"utf8",
		).toString("base64url");

		expect(verifyRecordingToken(`${forged}.${String(signature)}`, { current: KEY }).ok).to.equal(
			false,
		);
	});

	it("reports an expired token as expired, but only after the signature verified", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future(-10) }, KEY);

		expect(verifyRecordingToken(token, { current: KEY }).failure).to.equal("expired");
		// A forged token that is ALSO expired must read as forged: saying "expired" would confirm
		// the structure was right.
		expect(verifyRecordingToken(token, { current: OTHER_KEY }).failure).to.equal("bad-signature");
	});

	it("accepts the previous key during a rotation, and stops when it is removed", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, OTHER_KEY);

		expect(verifyRecordingToken(token, { current: KEY, previous: OTHER_KEY }).ok).to.equal(true);
		expect(verifyRecordingToken(token, { current: KEY }).ok).to.equal(false);
	});

	it("refuses structurally broken tokens without throwing", () => {
		for (const bad of ["", ".", "abc", "abc.", ".abc", "a".repeat(2000)]) {
			const result = verifyRecordingToken(bad, { current: KEY });
			expect(result.ok, bad).to.equal(false);
		}
	});

	it("serves media from a URL that carries the token, not the id", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, KEY);
		const url = recordingMediaPath(token);

		// No enumerable id anywhere in the URL: there is nothing to guess.
		expect(url).to.equal(`/api/v1/recordings/media?token=${encodeURIComponent(token)}`);
		expect(url).to.not.include(RECORDING);
	});

	/**
	 * The token is longer than Fastify's default `maxParamLength` of 100, which is why it is a
	 * query parameter rather than a path segment — `verify-cdr.ts` found this as a blanket 414.
	 * Pinned here so the path form cannot be reintroduced without the failure being named.
	 */
	it("mints a token too long to live in a Fastify route parameter", () => {
		const token = mintRecordingToken({ r: RECORDING, o: ORG, e: future() }, KEY);

		expect(token.length).to.be.greaterThan(100);
		expect(recordingMediaPath(token)).to.include("?token=");
	});
});

describe("recording object path", () => {
	it("resolves a normal object key under the root", () => {
		expect(resolveRecordingObjectPath("/opt/recordings", `${ORG}/call/rec.wav`)).to.equal(
			`/opt/recordings/${ORG}/call/rec.wav`,
		);
	});

	it("refuses a key that climbs out of the root", () => {
		for (const key of ["../../etc/passwd", "/etc/passwd", "a/../../../../etc/passwd"]) {
			expect(resolveRecordingObjectPath("/opt/recordings", key), key).to.equal(undefined);
		}
	});
});
