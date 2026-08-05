import { Args, Command } from "@oclif/core";
import { getActiveWorkspace, getConfig, setActiveWorkspace } from "../../config";
import { saveConfig } from "../../config/saveConfig";
import { CONFIG_FILE } from "../../constants";

export default class Use extends Command {
	static override readonly description = "set a Workspace as the default";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly args = {
		ref: Args.string({
			description: "The Workspace to unlink from",
			required: true,
		}),
	};

	public async run(): Promise<void> {
		const { args } = await this.parse(Use);
		const { ref } = args;
		const workspaces = getConfig(CONFIG_FILE);
		const updatedWorkspaces = setActiveWorkspace(ref, workspaces);
		const activeWorkspace = getActiveWorkspace(updatedWorkspaces);

		saveConfig(CONFIG_FILE, updatedWorkspaces);

		const { workspaceName, workspaceRef } = activeWorkspace;

		this.log(`Current Workspace: ${workspaceName} (${workspaceRef})`);
	}
}
