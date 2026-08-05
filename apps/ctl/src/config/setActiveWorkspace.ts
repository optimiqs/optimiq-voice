import { WorkspaceConfig } from "./types";

function setActiveWorkspace(
  ref: string,
  workspaces: WorkspaceConfig[]
): WorkspaceConfig[] {
  return workspaces.map((w) => {
    if (w.workspaceRef === ref) {
      return { ...w, active: true };
    }

    return { ...w, active: false };
  });
}

export { setActiveWorkspace };
