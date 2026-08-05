import { getLogger } from "@optimiq-voice/logger";

/**
 * Function that asserts that the given environment variable is set.
 *
 * @param {string[]} variables environment variables to check
 */
function assertEnvsAreSet(variables: string[]) {
	variables.forEach((variable: string) => {
		if (!(variable in process.env)) {
			const logger = getLogger({ service: "common", filePath: __filename });
			logger.error(`the environment variable ${variable} is required but was not found`);
			process.exit(1);
		}
	});
}

export { assertEnvsAreSet };
