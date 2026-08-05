import { WorkspaceConfig } from "./types";
import { workspaceConfigSchema } from "./validations";

function addWorkspace(config: WorkspaceConfig, workspaces: WorkspaceConfig[]): WorkspaceConfig[] {
	workspaceConfigSchema.parse(config);

	const deactivateAll = (workspaces: WorkspaceConfig[]) =>
		workspaces.map((workspace) => ({ ...workspace, active: false }));

	const workspaceIndex = workspaces.findIndex(
		(workspace) => workspace.workspaceRef === config.workspaceRef,
	);

	if (workspaceIndex === -1) {
		return deactivateAll(workspaces).concat({ ...config, active: true });
	}

	workspaces = deactivateAll(workspaces);
	workspaces[workspaceIndex] = { ...config, active: true };

	return workspaces;
}

export { addWorkspace };
