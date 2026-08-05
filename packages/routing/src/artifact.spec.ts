import { describe, expect, it } from "bun:test";
import {
	contextReachesTrunks,
	isRoutingArtifact,
	isRoutingContext,
	parseRoutingArtifact,
	ROUTING_ARTIFACT_VERSION,
	ROUTING_CONTEXTS,
} from "./artifact";
import { RoutingArtifactShapeError, RoutingArtifactVersionError } from "./errors";
import { anExtension, aPhoneNumber, aSnapshot, compiled } from "./fixtures";

const artifact = compiled(
	aSnapshot({ extensions: [anExtension()], phoneNumbers: [aPhoneNumber()] }),
);

describe("routing contexts", () => {
	it("names exactly the three contexts the rpc contract uses", () => {
		expect([...ROUTING_CONTEXTS]).toEqual(["inbound", "internal", "outbound"]);
	});

	it("recognises its own members", () => {
		expect(isRoutingContext("inbound")).toBe(true);
		expect(isRoutingContext("public")).toBe(false);
		expect(isRoutingContext(1)).toBe(false);
	});

	it("lets only the outbound context reach a trunk", () => {
		// Toll-fraud rule #1, expressed as a property of the data rather than a check to remember.
		expect(contextReachesTrunks("outbound")).toBe(true);
		expect(contextReachesTrunks("inbound")).toBe(false);
		expect(contextReachesTrunks("internal")).toBe(false);
	});
});

describe("parseRoutingArtifact", () => {
	it("accepts a compiled artifact", () => {
		expect(parseRoutingArtifact(artifact)).toBe(artifact);
	});

	it("accepts an artifact that has been through JSON", () => {
		expect(() => parseRoutingArtifact(JSON.parse(JSON.stringify(artifact)))).not.toThrow();
	});

	it("rejects a different schema version rather than walking it", () => {
		expect(() =>
			parseRoutingArtifact({ ...artifact, artifactVersion: ROUTING_ARTIFACT_VERSION + 1 }),
		).toThrow(RoutingArtifactVersionError);
	});

	it("reports the expected and received versions", () => {
		try {
			parseRoutingArtifact({ ...artifact, artifactVersion: 99 });
			throw new Error("expected a version error");
		} catch (error) {
			expect(error).toBeInstanceOf(RoutingArtifactVersionError);
			expect((error as RoutingArtifactVersionError).expected).toBe(ROUTING_ARTIFACT_VERSION);
			expect((error as RoutingArtifactVersionError).received).toBe(99);
		}
	});

	it("rejects a missing version", () => {
		const rest: Record<string, unknown> = { ...artifact };
		delete rest.artifactVersion;
		expect(() => parseRoutingArtifact(rest)).toThrow(RoutingArtifactVersionError);
	});

	it("rejects a non-object", () => {
		expect(() => parseRoutingArtifact("not an artifact")).toThrow(RoutingArtifactShapeError);
	});

	it("rejects null", () => {
		expect(() => parseRoutingArtifact(null)).toThrow(RoutingArtifactShapeError);
	});

	it("rejects an array", () => {
		expect(() => parseRoutingArtifact([])).toThrow(RoutingArtifactShapeError);
	});

	it("rejects a missing organization id", () => {
		expect(() => parseRoutingArtifact({ ...artifact, organizationId: "" })).toThrow(
			RoutingArtifactShapeError,
		);
	});

	it("rejects a missing node table", () => {
		expect(() => parseRoutingArtifact({ ...artifact, nodes: undefined })).toThrow(
			RoutingArtifactShapeError,
		);
	});

	it("rejects a node table that is an array", () => {
		expect(() => parseRoutingArtifact({ ...artifact, nodes: [] })).toThrow(
			RoutingArtifactShapeError,
		);
	});

	it("rejects a callBlock that is not an array", () => {
		expect(() => parseRoutingArtifact({ ...artifact, callBlock: {} })).toThrow(
			RoutingArtifactShapeError,
		);
	});

	it("names the offending field", () => {
		try {
			parseRoutingArtifact({ ...artifact, snapshotHash: "" });
			throw new Error("expected a shape error");
		} catch (error) {
			expect((error as RoutingArtifactShapeError).field).toBe("snapshotHash");
		}
	});
});

describe("isRoutingArtifact", () => {
	it("is true for a compiled artifact", () => {
		expect(isRoutingArtifact(artifact)).toBe(true);
	});

	it("is false for a stale version, so a reader can recompile instead of throwing", () => {
		expect(isRoutingArtifact({ ...artifact, artifactVersion: 0 })).toBe(false);
	});

	it("is false for rubbish", () => {
		expect(isRoutingArtifact(undefined)).toBe(false);
	});
});
