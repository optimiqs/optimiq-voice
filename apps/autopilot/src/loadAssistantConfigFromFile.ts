import * as path from "path";
import { getLogger } from "@optimiq-voice/logger";
import { AssistantConfig, loadAndValidateAssistant } from ".";

const logger = getLogger({ service: "autopilot", filePath: __filename });

function loadAssistantConfigFromFile(
  pathToAssistantConfig: string
): AssistantConfig {
  try {
    const assistantPath = path.resolve(process.cwd(), pathToAssistantConfig);
    return loadAndValidateAssistant(assistantPath);
  } catch (error) {
    logger.error("Error loading assistant config from file", error);
    throw error;
  }
}

export { loadAssistantConfigFromFile };
