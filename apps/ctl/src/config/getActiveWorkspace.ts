import { WorkspaceConfig } from "./types";

function getActiveWorkspace(workspaces: WorkspaceConfig[]): WorkspaceConfig {
	return workspaces.find((w) => w.active === true);
}

export { getActiveWorkspace };
