import fs from "fs";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "common", filePath: __filename });

/**
 * Function that asserts that the given file exists.
 * @param {string} file file to check
 */
export function assertFileExists(file: string) {
  if (!fs.existsSync(file)) {
    logger.error(`the file ${file} is required but does not exist`);
    process.exit(1);
  }
}
