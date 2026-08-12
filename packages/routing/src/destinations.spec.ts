import { describe, expect, it } from "bun:test";
import {
	DESTINATION_TARGET_COLLECTIONS,
	DESTINATION_TYPE_KINDS,
	DESTINATION_TYPES,
	destinationKey,
	destinationKind,
	destinationShapeIssues,
	destinationTargetCollection,
	isDestinationType,
	isEntityDestination,
	readDestination,
	readNamedDestination,
} from "./destinations";

/**
 * This vocabulary is a mirror of `packages/pbx-db/src/destinations.ts`. These assertions are what
 * makes the mirror safe: if the database package gains a destination type and this one does not,
 * the compiler would silently drop every route pointing at it, and only a pinned list catches that.
 */
describe("destination vocabulary", () => {
	it("names exactly the sixteen pbx-db destination types", () => {
		expect([...DESTINATION_TYPES]).toEqual([
			"extension",
			"ivr",
			"ring-group",
			"queue",
			"voicemail",
			"conference",
			"park",
			"paging-group",
			"time-condition",
			"call-flow",
			"stream",
			"dial-by-name",
			"alias",
			"external",
			"application",
			"hangup",
		]);
	});

	/**
	 * `alias` is entity-backed and compiles to NO node — it resolves to whatever its target resolved
	 * to. Pinned here because it is the one member of this vocabulary whose kind does not predict
	 * what the compiler emits, and a later reader looking for an `alias` plan node needs to be told
	 * there is not one.
	 */
	it("makes alias an entity destination that resolves through to its target", () => {
		expect(destinationKind("alias")).toBe("entity");
		expect(DESTINATION_TARGET_COLLECTIONS.alias).toBe("destinationAliases");
	});

	it("assigns a kind to every type", () => {
		for (const type of DESTINATION_TYPES) {
			expect(DESTINATION_TYPE_KINDS[type]).toBeDefined();
		}
	});

	it("assigns a target collection to every entity type and none to the others", () => {
		for (const type of DESTINATION_TYPES) {
			const collection = DESTINATION_TARGET_COLLECTIONS[type];
			if (DESTINATION_TYPE_KINDS[type] === "entity") {
				expect(collection).toBeTypeOf("string");
			} else {
				expect(collection).toBeNull();
			}
		}
	});

	it("classifies external and application as value-backed", () => {
		expect(destinationKind("external")).toBe("value");
		expect(destinationKind("application")).toBe("value");
	});

	it("classifies hangup as terminal", () => {
		expect(destinationKind("hangup")).toBe("terminal");
	});

	it("recognises its own members", () => {
		expect(isDestinationType("ring-group")).toBe(true);
		expect(isDestinationType("ring_group")).toBe(false);
		expect(isDestinationType(42)).toBe(false);
	});

	it("answers isEntityDestination", () => {
		expect(isEntityDestination("queue")).toBe(true);
		expect(isEntityDestination("hangup")).toBe(false);
	});

	it("maps a type to its snapshot collection", () => {
		expect(destinationTargetCollection("ivr")).toBe("ivrMenus");
		expect(destinationTargetCollection("hangup")).toBeNull();
	});
});

describe("destinationShapeIssues", () => {
	it("accepts an entity destination with a ref", () => {
		expect(
			destinationShapeIssues({ destinationType: "extension", destinationRef: "ext-1" }),
		).toEqual([]);
	});

	it("rejects an entity destination without a ref", () => {
		expect(destinationShapeIssues({ destinationType: "extension" })).toEqual(["missing-ref"]);
	});

	it("rejects an entity destination with an empty ref", () => {
		expect(destinationShapeIssues({ destinationType: "extension", destinationRef: "" })).toEqual([
			"missing-ref",
		]);
	});

	it("accepts a value destination with a value", () => {
		expect(
			destinationShapeIssues({
				destinationType: "external",
				destinationData: { value: "+15551230001" },
			}),
		).toEqual([]);
	});

	it("rejects a value destination that also carries a ref", () => {
		expect(
			destinationShapeIssues({
				destinationType: "external",
				destinationRef: "ext-1",
				destinationData: { value: "+1" },
			}),
		).toEqual(["unexpected-ref"]);
	});

	it("rejects a value destination with a blank value", () => {
		expect(
			destinationShapeIssues({ destinationType: "external", destinationData: { value: "   " } }),
		).toEqual(["missing-value"]);
	});

	it("accepts a bare hangup", () => {
		expect(destinationShapeIssues({ destinationType: "hangup" })).toEqual([]);
	});

	it("rejects a hangup with a ref", () => {
		expect(destinationShapeIssues({ destinationType: "hangup", destinationRef: "ext-1" })).toEqual([
			"unexpected-ref",
		]);
	});

	it("reports an unknown type without going further", () => {
		expect(
			destinationShapeIssues({ destinationType: "teleport" as never, destinationRef: "x" }),
		).toEqual(["unknown-type"]);
	});
});

describe("readDestination / readNamedDestination", () => {
	it("reads a primary trio", () => {
		expect(
			readDestination({ destinationType: "queue", destinationRef: "q-1", destinationData: null }),
		).toEqual({ destinationType: "queue", destinationRef: "q-1", destinationData: null });
	});

	it("reads a named trio", () => {
		expect(
			readNamedDestination(
				{ timeoutDestinationType: "voicemail", timeoutDestinationRef: "vm-1" },
				"timeout",
			),
		).toEqual({ destinationType: "voicemail", destinationRef: "vm-1", destinationData: null });
	});

	it("returns null for an unset named trio", () => {
		expect(readNamedDestination({ timeoutDestinationType: null }, "timeout")).toBeNull();
	});

	it("returns null when the named trio is absent entirely", () => {
		expect(readNamedDestination({}, "failover")).toBeNull();
	});

	it("preserves an unknown stored type so it can be reported verbatim", () => {
		expect(readNamedDestination({ timeoutDestinationType: "teleport" }, "timeout")).toEqual({
			destinationType: "teleport" as never,
			destinationRef: null,
		});
	});
});

describe("destinationKey", () => {
	it("folds entity destinations to type and ref", () => {
		expect(destinationKey({ destinationType: "extension", destinationRef: "ext-1" })).toBe(
			"extension:ext-1",
		);
	});

	it("gives two references to the same entity the same key", () => {
		expect(destinationKey({ destinationType: "queue", destinationRef: "q-1" })).toBe(
			destinationKey({ destinationType: "queue", destinationRef: "q-1" }),
		);
	});

	it("folds value destinations to type and value", () => {
		expect(
			destinationKey({ destinationType: "external", destinationData: { value: "+15551230001" } }),
		).toBe("external:+15551230001");
	});

	it("includes application args, sorted, so argument order does not fork the key", () => {
		const left = destinationKey({
			destinationType: "application",
			destinationData: { value: "echo", args: { b: 2, a: 1 } },
		});
		const right = destinationKey({
			destinationType: "application",
			destinationData: { value: "echo", args: { a: 1, b: 2 } },
		});
		expect(left).toBe(right);
	});

	it("folds a hangup to its cause", () => {
		expect(
			destinationKey({ destinationType: "hangup", destinationData: { cause: "USER_BUSY" } }),
		).toBe("hangup:USER_BUSY");
	});
});
