import { describe, expect, it } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import * as routing from "./index";

/**
 * `@optimiq-voice/routing` is a pure domain package. Its value comes from being safe to import
 * anywhere — the API's save path, the engine's cache-miss path, a CLI that explains a routing
 * decision, a test — which only holds while it stays dependency-light. A single `drizzle-orm` or
 * `@nestjs/common` import would drag a database driver into the engine, so the constraint is
 * enforced rather than documented.
 */
describe("package purity", () => {
	it("depends on nothing but the telephony domain package", () => {
		expect((packageJson as { dependencies?: Record<string, string> }).dependencies).toEqual({
			"@optimiq-voice/telephony": "workspace:*",
		});
	});

	it("declares no peer dependencies", () => {
		expect(
			(packageJson as { peerDependencies?: Record<string, string> }).peerDependencies,
		).toBeUndefined();
	});

	it("is named for its scope", () => {
		expect(packageJson.name).toBe("@optimiq-voice/routing");
	});
});

describe("public surface", () => {
	it("exports the compiler", () => {
		for (const name of ["compileRoutingArtifact", "tryCompileRoutingArtifact"] as const) {
			expect(routing).toHaveProperty(name);
		}
	});

	it("exports the three resolvers", () => {
		for (const name of ["resolveInbound", "resolveInternal", "resolveOutbound"] as const) {
			expect(routing).toHaveProperty(name);
		}
	});

	it("exports the cache contract", () => {
		for (const name of [
			"routingCacheKey",
			"invalidationKeysFor",
			"invalidationKeysForBatch",
			"affectsRouting",
			"snapshotHash",
			"isArtifactFresh",
			"ROUTING_CACHE_BUCKET",
		] as const) {
			expect(routing).toHaveProperty(name);
		}
	});

	it("exports the artifact guards", () => {
		for (const name of [
			"parseRoutingArtifact",
			"isRoutingArtifact",
			"ROUTING_ARTIFACT_VERSION",
		] as const) {
			expect(routing).toHaveProperty(name);
		}
	});

	it("exports the vocabularies a consumer switches on", () => {
		for (const name of [
			"PLAN_NODE_KINDS",
			"DESTINATION_TYPES",
			"ROUTING_CONTEXTS",
			"DIAGNOSTIC_CODES",
			"TOLL_CLASSES",
			"FEATURE_CODE_ACTIONS",
			"DEFAULT_FEATURE_CODES",
		] as const) {
			expect(routing).toHaveProperty(name);
		}
	});

	it("exports the snapshot helpers the API's loader needs", () => {
		for (const name of ["emptySnapshot", "SNAPSHOT_COLLECTIONS", "tollClassCovers"] as const) {
			expect(routing).toHaveProperty(name);
		}
	});

	it("does not leak the test fixtures", () => {
		expect(routing).not.toHaveProperty("aSnapshot");
		expect(routing).not.toHaveProperty("compiled");
	});

	it("gives every routing error a common base", () => {
		expect(new routing.RoutingSnapshotError("a", "b")).toBeInstanceOf(routing.RoutingError);
		expect(new routing.RoutingCompileError("org", [])).toBeInstanceOf(routing.RoutingError);
		expect(new routing.RoutingArtifactVersionError(1, 2)).toBeInstanceOf(routing.RoutingError);
		expect(new routing.RoutingArtifactShapeError("a", "b")).toBeInstanceOf(routing.RoutingError);
		expect(new routing.PlanNodeNotFoundError("x")).toBeInstanceOf(routing.RoutingError);
	});

	it("names every error after its class", () => {
		expect(new routing.RoutingSnapshotError("a", "b").name).toBe("RoutingSnapshotError");
		expect(new routing.PlanNodeNotFoundError("x").name).toBe("PlanNodeNotFoundError");
	});
});
