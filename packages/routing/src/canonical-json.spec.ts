import { describe, expect, it } from "bun:test";
import { canonicalEquals, canonicalJson } from "./canonical-json";
import { RoutingSnapshotError } from "./errors";

describe("canonicalJson — key ordering", () => {
	it("sorts object keys", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("gives the same output regardless of insertion order", () => {
		expect(canonicalJson({ z: 1, m: 2, a: 3 })).toBe(canonicalJson({ a: 3, m: 2, z: 1 }));
	});

	it("sorts nested keys too", () => {
		expect(canonicalJson({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}');
	});

	it("preserves array order", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	it("treats differently ordered arrays as different values", () => {
		expect(canonicalEquals([1, 2], [2, 1])).toBe(false);
	});
});

describe("canonicalJson — absent values", () => {
	it("drops undefined object values", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});

	it("treats an absent key and an undefined key as the same value", () => {
		expect(canonicalEquals({ a: 1 }, { a: 1, b: undefined })).toBe(true);
	});

	it("keeps null, which is a value and not an absence", () => {
		expect(canonicalJson({ a: null })).toBe('{"a":null}');
	});

	it("distinguishes null from undefined", () => {
		expect(canonicalEquals({ a: null }, { a: undefined })).toBe(false);
	});

	it("renders undefined inside an array as null", () => {
		expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
	});
});

describe("canonicalJson — scalars", () => {
	it("normalises negative zero", () => {
		expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
	});

	it("rejects NaN", () => {
		expect(() => canonicalJson({ a: Number.NaN })).toThrow(RoutingSnapshotError);
	});

	it("rejects Infinity", () => {
		expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(RoutingSnapshotError);
	});

	it("escapes strings as JSON does", () => {
		expect(canonicalJson({ a: 'He said "hi"' })).toBe('{"a":"He said \\"hi\\""}');
	});

	it("serialises booleans", () => {
		expect(canonicalJson([true, false])).toBe("[true,false]");
	});
});

describe("canonicalJson — the JSON round-trip guard", () => {
	// The artifact is written to a KV bucket and read back by another process. Anything that does
	// not survive `JSON.parse(JSON.stringify(x))` must be refused here rather than discovered there.
	it("rejects a Date", () => {
		expect(() => canonicalJson({ at: new Date() })).toThrow(RoutingSnapshotError);
	});

	it("rejects a Map", () => {
		expect(() => canonicalJson({ nodes: new Map() })).toThrow(RoutingSnapshotError);
	});

	it("rejects a RegExp", () => {
		expect(() => canonicalJson({ pattern: /abc/ })).toThrow(RoutingSnapshotError);
	});

	it("rejects a class instance", () => {
		class Node {}
		expect(() => canonicalJson({ node: new Node() })).toThrow(RoutingSnapshotError);
	});

	it("rejects a function", () => {
		expect(() => canonicalJson({ fn: () => undefined })).toThrow(RoutingSnapshotError);
	});

	it("accepts a null-prototype object", () => {
		const value = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
		expect(canonicalJson(value)).toBe('{"a":1}');
	});

	it("names the failing path in the error", () => {
		expect(() => canonicalJson({ outer: { inner: [new Date()] } })).toThrow(
			/\$\.outer\.inner\[0\]/,
		);
	});
});

describe("canonicalEquals", () => {
	it("is true for structurally identical values", () => {
		expect(canonicalEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
	});

	it("is false when a nested value differs", () => {
		expect(canonicalEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
	});
});
