import { getLogger } from "@optimiq-voice/logger";

/** Raised when a required environment variable is absent. */
class MissingEnvironmentError extends Error {
	readonly missing: string[];

	constructor(missing: string[]) {
		const plural = missing.length !== 1;
		super(
			`the environment variable${plural ? "s" : ""} ${missing.join(", ")} ` +
				`${plural ? "are" : "is"} required but ${plural ? "were" : "was"} not found`,
		);
		this.name = "MissingEnvironmentError";
		this.missing = missing;
	}
}

/**
 * Asserts that the given environment variables are set.
 *
 * Throws rather than calling `process.exit(1)`. The previous implementation exited immediately
 * after `logger.error`, so under `LOGS_LEVEL=none` — which every test run uses — a missing root
 * `.env` produced a bare exit code 1 and no output at all. A thrown error always reaches stderr
 * with a stack, and lets a caller that can recover do so.
 *
 * Every missing variable is reported, not only the first, so one run tells the whole story.
 *
 * @param {string[]} variables environment variables to check
 * @throws {MissingEnvironmentError} when any of them is unset
 */
function assertEnvsAreSet(variables: string[]) {
	const missing = variables.filter((variable: string) => !(variable in process.env));

	if (missing.length === 0) {
		return;
	}

	const error = new MissingEnvironmentError(missing);
	const logger = getLogger({ service: "common", filePath: __filename });
	logger.error(error.message);
	throw error;
}

export { assertEnvsAreSet, MissingEnvironmentError };
