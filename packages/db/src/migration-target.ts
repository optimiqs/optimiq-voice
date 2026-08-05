export const DATABASE_DEPLOYMENT_STAGES = ["development", "test", "staging", "production"] as const;

export type DatabaseDeploymentStage = (typeof DATABASE_DEPLOYMENT_STAGES)[number];

export type NodeEnvironment = "development" | "test" | "production";

/** Raised when a migration command could act on a database it was not aimed at. */
export class MigrationTargetError extends Error {
	readonly _tag = "MigrationTargetError" as const;

	constructor(message: string) {
		super(message);
		this.name = "MigrationTargetError";
	}
}

export function isDatabaseDeploymentStage(value: string): value is DatabaseDeploymentStage {
	return DATABASE_DEPLOYMENT_STAGES.some((stage) => stage === value);
}

/**
 * Every migration entry point must state which stage it believes it is migrating. The flag is
 * compared with the stage resolved from the environment so a `staging` command can never be run
 * against a production connection string that happens to be exported in the shell.
 */
export function parseExpectedMigrationStage(args: readonly string[]): DatabaseDeploymentStage {
	const inline = args.find((argument) => argument.startsWith("--expected-stage="));
	const flagIndex = args.indexOf("--expected-stage");
	const value =
		inline?.slice("--expected-stage=".length) ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);

	if (!value || !isDatabaseDeploymentStage(value)) {
		throw new MigrationTargetError(
			`Migration requires --expected-stage with one of: ${DATABASE_DEPLOYMENT_STAGES.join(", ")}.`,
		);
	}
	return value;
}

export function resolveDatabaseDeploymentStage(input: {
	readonly configuredStage?: string | undefined;
	readonly nodeEnvironment: NodeEnvironment;
}): DatabaseDeploymentStage {
	if (input.configuredStage) {
		if (!isDatabaseDeploymentStage(input.configuredStage)) {
			throw new MigrationTargetError(
				`DATABASE_DEPLOYMENT_STAGE must be one of: ${DATABASE_DEPLOYMENT_STAGES.join(", ")}.`,
			);
		}
		return input.configuredStage;
	}
	if (input.nodeEnvironment === "production") {
		throw new MigrationTargetError(
			"DATABASE_DEPLOYMENT_STAGE is required when NODE_ENV=production so staging and production cannot be confused.",
		);
	}
	return input.nodeEnvironment;
}

export function assertMigrationStage(input: {
	readonly actualStage: DatabaseDeploymentStage;
	readonly expectedStage: DatabaseDeploymentStage;
	readonly productionConfirmation?: string | undefined;
}): void {
	if (input.actualStage !== input.expectedStage) {
		throw new MigrationTargetError(
			`Database migration target mismatch: command expects '${input.expectedStage}' but runtime is '${input.actualStage}'.`,
		);
	}
	if (input.actualStage === "production" && input.productionConfirmation !== "apply") {
		throw new MigrationTargetError(
			"Production migration requires DATABASE_MIGRATION_CONFIRM_PRODUCTION=apply.",
		);
	}
}

/** Human-readable, credential-free description of the connection a migration is about to touch. */
export function describeDatabaseMigrationTarget(databaseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(databaseUrl);
	} catch {
		throw new MigrationTargetError("Migration database URL is not a valid connection string.");
	}
	const database = parsed.pathname.replace(/^\/+/u, "") || "<default>";
	return `postgres://${parsed.hostname}:${parsed.port || "5432"}/${database}`;
}
