import { readFileSync } from "fs";
import path from "path";
import { load } from "js-yaml";
import * as SDK from "@optimiq-voice/sdk";
import {
  CreateApplicationRequest,
  UpdateApplicationRequest
} from "@optimiq-voice/types";
import { AppConfig } from "./types";

export async function createOrUpdateApplication(
  client: SDK.Client,
  filePath: string,
  appRef?: string,
  isUpdate = false
) {
  const fileContent = readFileSync(filePath, "utf8");
  const fileExt = path.extname(filePath).toLowerCase();
  type Config = CreateApplicationRequest & AppConfig & { ref?: string };
  let config: Config;

  if (fileExt === ".yaml" || fileExt === ".yml") {
    config = load(fileContent) as Config;
  } else if (fileExt === ".json") {
    config = JSON.parse(fileContent) as Config;
  } else {
    throw new Error("Unsupported file format. Please use YAML or JSON files.");
  }

  const applications = new SDK.Applications(client);

  delete config.testCases;
  delete config.intelligence?.config?.languageModel?.apiKey;

  if (isUpdate) {
    // The positional appRef takes precedence over any `ref` in the file; fall
    // back to the file's `ref` when the positional is omitted.
    const ref = appRef ?? config.ref;

    if (!ref) {
      throw new Error(
        "An Application ref is required to update. Provide it as the positional argument or include `ref` in the file."
      );
    }

    delete config.ref;
    const updateConfig: UpdateApplicationRequest = {
      ...config,
      ref
    };
    return applications.updateApplication(updateConfig);
  }

  return applications.createApplication(config);
}
