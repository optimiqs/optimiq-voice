import { describe, expect, it } from "bun:test";
import { sha256, sha256Bytes, utf8Bytes } from "./sha256";

/**
 * The published FIPS 180-4 / NIST test vectors. If any of these move, the artifact hash of every
 * tenant moves with them, so they are pinned literally rather than computed.
 */
describe("sha256 — NIST vectors", () => {
	it("hashes the empty string", () => {
		expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("hashes 'abc'", () => {
		expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("hashes the 56-byte two-block vector", () => {
		expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
		);
	});

	it("hashes the 112-byte vector", () => {
		expect(
			sha256(
				"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
			),
		).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
	});

	it("hashes a million 'a' characters", () => {
		expect(sha256("a".repeat(1_000_000))).toBe(
			"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
		);
	});
});

describe("sha256 — padding boundaries", () => {
	// 55 bytes is the last length that fits in one block with its length field; 56 forces a second
	// block, and 64 forces a whole extra block of padding. An off-by-one here would hide until a
	// tenant's snapshot happened to land on the boundary.
	it("agrees with itself either side of the 55/56-byte boundary", () => {
		const fiftyFive = sha256("x".repeat(55));
		const fiftySix = sha256("x".repeat(56));
		expect(fiftyFive).toHaveLength(64);
		expect(fiftySix).toHaveLength(64);
		expect(fiftyFive).not.toBe(fiftySix);
	});

	it("hashes exactly one block", () => {
		expect(sha256("x".repeat(64))).toBe(
			"7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c",
		);
	});

	it("produces 64 lower-case hex characters for every length up to three blocks", () => {
		for (let length = 0; length <= 200; length += 1) {
			expect(sha256("a".repeat(length))).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});

describe("utf8Bytes", () => {
	it("encodes ASCII one byte per character", () => {
		expect([...utf8Bytes("abc")]).toEqual([97, 98, 99]);
	});

	it("encodes two-byte code points", () => {
		expect([...utf8Bytes("é")]).toEqual([0xc3, 0xa9]);
	});

	it("encodes three-byte code points", () => {
		expect([...utf8Bytes("€")]).toEqual([0xe2, 0x82, 0xac]);
	});

	it("encodes a surrogate pair as one four-byte code point", () => {
		expect([...utf8Bytes("😀")]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
	});

	it("hashes non-ASCII text stably", () => {
		expect(sha256("héllo")).toBe(sha256Bytes(utf8Bytes("héllo")));
	});
});

describe("sha256 — determinism", () => {
	it("returns the same digest for the same input every time", () => {
		const input = JSON.stringify({ a: 1, b: [1, 2, 3] });
		expect(sha256(input)).toBe(sha256(input));
	});

	it("changes when a single character changes", () => {
		expect(sha256("routing-artifact-a")).not.toBe(sha256("routing-artifact-b"));
	});
});
