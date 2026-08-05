import { WorkspaceConfig } from "./types";

function removeWorkspace(
  ref: string,
  workspaces: WorkspaceConfig[]
): WorkspaceConfig[] {
  return workspaces.filter((w) => w.workspaceRef !== ref);
}

export { removeWorkspace };
