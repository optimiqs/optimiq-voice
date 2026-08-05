import { describe, expect, it } from "bun:test";
import {
	assertMigrationStage,
	describeDatabaseMigrationTarget,
	MigrationTargetError,
	parseExpectedMigrationStage,
	resolveDatabaseDeploymentStage,
} from "./migration-target";

describe("parseExpectedMigrationStage", () => {
	it("accepts both the space and equals flag forms", () => {
		expect(parseExpectedMigrationStage(["--expected-stage", "staging"])).toBe("staging");
		expect(parseExpectedMigrationStage(["--expected-stage=production"])).toBe("production");
	});

	it.each([[[]], [["--expected-stage"]], [["--expected-stage=prod"]], [["staging"]]])(
		"refuses to run without an explicit, valid stage (%p)",
		(args) => {
			expect(() => parseExpectedMigrationStage(args)).toThrow(MigrationTargetError);
		},
	);
});

describe("resolveDatabaseDeploymentStage", () => {
	it("prefers the configured stage", () => {
		expect(
			resolveDatabaseDeploymentStage({
				configuredStage: "staging",
				nodeEnvironment: "production",
			}),
		).toBe("staging");
	});

	it("falls back to NODE_ENV outside production", () => {
		expect(resolveDatabaseDeploymentStage({ nodeEnvironment: "test" })).toBe("test");
	});

	it("requires an explicit stage in production so staging cannot be mistaken for production", () => {
		expect(() => resolveDatabaseDeploymentStage({ nodeEnvironment: "production" })).toThrow(
			MigrationTargetError,
		);
	});

	it("rejects an unknown configured stage", () => {
		expect(() =>
			resolveDatabaseDeploymentStage({
				configuredStage: "prod",
				nodeEnvironment: "development",
			}),
		).toThrow(MigrationTargetError);
	});
});

describe("assertMigrationStage", () => {
	it("passes when the command and the runtime agree", () => {
		expect(() =>
			assertMigrationStage({
				actualStage: "development",
				expectedStage: "development",
			}),
		).not.toThrow();
	});

	it("blocks a command aimed at a different stage", () => {
		expect(() =>
			assertMigrationStage({
				actualStage: "production",
				expectedStage: "staging",
			}),
		).toThrow(MigrationTargetError);
	});

	it("requires an explicit confirmation for production", () => {
		expect(() =>
			assertMigrationStage({
				actualStage: "production",
				expectedStage: "production",
			}),
		).toThrow(MigrationTargetError);

		expect(() =>
			assertMigrationStage({
				actualStage: "production",
				expectedStage: "production",
				productionConfirmation: "apply",
			}),
		).not.toThrow();
	});
});

describe("describeDatabaseMigrationTarget", () => {
	it("describes the target without leaking credentials", () => {
		expect(
			describeDatabaseMigrationTarget("postgresql://user:secret@db.internal:6432/optimiq_voice"),
		).toBe("postgres://db.internal:6432/optimiq_voice");
	});

	it("defaults the port and the database name", () => {
		expect(describeDatabaseMigrationTarget("postgresql://db.internal/")).toBe(
			"postgres://db.internal:5432/<default>",
		);
	});

	it("rejects a malformed connection string", () => {
		expect(() => describeDatabaseMigrationTarget("not-a-url")).toThrow(MigrationTargetError);
	});
});
