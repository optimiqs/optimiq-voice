import { Command } from "@oclif/core";
import cliui from "cliui";
import { getConfig } from "../../config";
import { CONFIG_FILE } from "../../constants";

export default class Active extends Command {
  static override description = "display the name of the active Workspace";
  static override examples = ["<%= config.bin %> <%= command.id %>"];

  public async run(): Promise<void> {
    const workspaces = getConfig(CONFIG_FILE);
    const activeWorkspace = workspaces.find((w) => w.active === true);

    const { workspaceName, workspaceRef, workspaceAccessKeyId, endpoint } =
      activeWorkspace;

    const ui = cliui({ width: 200 });

    ui.div(
      "ACTIVE WORKSPACE\n" +
        "------------------\n" +
        `NAME: \t${workspaceName}\n` +
        `REF: \t${workspaceRef}\n` +
        `ACCESS KEY ID: \t${workspaceAccessKeyId}\n` +
        `ENDPOINT: \t${endpoint}\n`
    );

    this.log(ui.toString());
  }
}
