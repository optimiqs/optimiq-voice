import fs from "fs";
import { WorkspaceConfig } from "./types";
// import { workspaceConfigSchema } from "./validations";

function getConfig(path: string): WorkspaceConfig[] {
  if (!fs.existsSync(path)) {
    return [];
  }

  const data = fs.readFileSync(path, "utf8");
  // workspaceConfigSchema.parse(config);

  return JSON.parse(data) as WorkspaceConfig[];
}

export { getConfig };
