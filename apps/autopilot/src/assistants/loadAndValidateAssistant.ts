import fs from "fs";
import { assistantSchema } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AssistantConfig } from "./types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

function loadAndValidateAssistant(path: string): AssistantConfig {
	if (!fs.existsSync(path)) {
		logger.error("assistant file not found", { path });
		process.exit(1);
	}

	try {
		const fileContent = fs.readFileSync(path, "utf8");
		const assistant = JSON.parse(fileContent) as unknown;

		return assistantSchema.parse(assistant);
	} catch (e) {
		logger.error("error parsing or validating assistant file", {
			path,
			error: e,
		});
		process.exit(1);
	}
}

export { loadAndValidateAssistant };
