import { Command } from "@oclif/core";
import cliui from "cliui";
import { getConfig } from "../../config";
import { CONFIG_FILE } from "../../constants";

export default class List extends Command {
	static override description = "display all linked Workspaces";
	static override examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<void> {
		const workspaces = getConfig(CONFIG_FILE);
		const ui = cliui({ width: 120 });

		ui.div(
			{ text: "REF", padding: [0, 0, 0, 0] },
			{ text: "NAME", padding: [0, 0, 0, 0] },
			{ text: "STATUS", padding: [0, 0, 0, 0] },
		);

		workspaces.forEach((workspace) => {
			ui.div(
				{ text: workspace.workspaceRef, padding: [0, 0, 0, 0] },
				{ text: workspace.workspaceName, padding: [0, 0, 0, 0] },
				{ text: workspace.active ? "[ACTIVE]" : "", padding: [0, 0, 0, 0] },
			);
		});

		this.log(ui.toString());
	}
}
