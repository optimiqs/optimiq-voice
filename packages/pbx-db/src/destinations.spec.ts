import { describe, expect, it } from "bun:test";
import {
	assertDestination,
	DESTINATION_TARGET_TABLES,
	DESTINATION_TYPE_KINDS,
	DESTINATION_TYPES,
	destinationColumnNames,
	DestinationColumnPrefixError,
	destinationConsistencySql,
	DestinationContractError,
	destinationKind,
	destinationTargetTable,
	isDestinationType,
	isValidDestination,
	validateDestination,
} from "./destinations";

const REF = "0198f0a1-1e70-7000-8000-0000000000aa";

describe("destination type registry", () => {
	it("classifies every declared type exactly once", () => {
		expect(new Set(DESTINATION_TYPES).size).toBe(DESTINATION_TYPES.length);
		for (const type of DESTINATION_TYPES) {
			expect(DESTINATION_TYPE_KINDS[type]).toBeDefined();
			expect(DESTINATION_TARGET_TABLES[type]).toBeDefined();
		}
	});

	it("gives entity-backed types a target table and value/terminal types none", () => {
		for (const type of DESTINATION_TYPES) {
			const target = destinationTargetTable(type);
			if (destinationKind(type) === "entity") {
				expect(target).toBeString();
			} else {
				expect(target).toBeNull();
			}
		}
	});

	it("narrows unknown strings", () => {
		expect(isDestinationType("extension")).toBe(true);
		expect(isDestinationType("ring_group")).toBe(false);
	});
});

describe("validateDestination", () => {
	it("accepts an entity destination carrying a ref", () => {
		expect(isValidDestination({ destinationType: "ivr", destinationRef: REF })).toBe(true);
	});

	it("rejects an entity destination with no ref", () => {
		const issues = validateDestination({ destinationType: "queue" });
		expect(issues.map((issue) => issue.code)).toEqual(["missing-ref"]);
	});

	it("rejects a ref that is not a uuid", () => {
		const issues = validateDestination({ destinationType: "queue", destinationRef: "42" });
		expect(issues.map((issue) => issue.code)).toContain("invalid-ref");
	});

	it("accepts a value destination carrying data", () => {
		expect(
			isValidDestination({
				destinationType: "external",
				destinationData: { value: "+15551234567" },
			}),
		).toBe(true);
	});

	it("rejects a value destination that carries a ref or blank data", () => {
		expect(
			validateDestination({
				destinationType: "external",
				destinationRef: REF,
				destinationData: { value: "+15551234567" },
			}).map((issue) => issue.code),
		).toEqual(["unexpected-ref"]);
		expect(
			validateDestination({ destinationType: "application", destinationData: { value: "  " } }).map(
				(issue) => issue.code,
			),
		).toEqual(["missing-data"]);
	});

	it("accepts a bare hangup and rejects one carrying a target", () => {
		expect(isValidDestination({ destinationType: "hangup" })).toBe(true);
		expect(
			isValidDestination({ destinationType: "hangup", destinationData: { cause: "BUSY" } }),
		).toBe(true);
		expect(
			validateDestination({ destinationType: "hangup", destinationRef: REF }).map(
				(issue) => issue.code,
			),
		).toEqual(["unexpected-ref"]);
	});

	it("reports an unknown type without cascading", () => {
		const issues = validateDestination({
			destinationType: "carrier-pigeon" as never,
			destinationRef: REF,
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]?.code).toBe("unknown-type");
	});

	it("throws a tagged error from assertDestination", () => {
		expect(() => assertDestination({ destinationType: "extension" })).toThrow(
			DestinationContractError,
		);
		expect(() =>
			assertDestination({ destinationType: "extension", destinationRef: REF }),
		).not.toThrow();
	});
});

describe("destination column naming", () => {
	it("builds the primary and prefixed trios", () => {
		expect(destinationColumnNames()).toEqual({
			type: "destination_type",
			ref: "destination_ref",
			data: "destination_data",
		});
		expect(destinationColumnNames("timeout_")).toEqual({
			type: "timeout_destination_type",
			ref: "timeout_destination_ref",
			data: "timeout_destination_data",
		});
	});

	it("refuses a prefix that could not be inlined into DDL", () => {
		expect(() => destinationColumnNames("bad prefix_")).toThrow(DestinationColumnPrefixError);
		expect(() => destinationColumnNames("drop_table;--_")).toThrow(DestinationColumnPrefixError);
	});
});

describe("destinationConsistencySql", () => {
	it("mentions every type exactly once across its clauses", () => {
		const sql = destinationConsistencySql();
		for (const type of DESTINATION_TYPES) {
			expect(sql).toContain(`'${type}'`);
		}
	});

	it("allows the fully unset trio only when the trio is optional", () => {
		expect(destinationConsistencySql("timeout_", true)).toContain(
			"timeout_destination_type is null",
		);
		expect(destinationConsistencySql("timeout_", false)).not.toContain(
			"timeout_destination_type is null and",
		);
	});
});
