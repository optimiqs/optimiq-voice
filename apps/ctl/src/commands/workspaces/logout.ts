import { Args, Command } from "@oclif/core";
import { getConfig, removeWorkspace } from "../../config";
import { saveConfig } from "../../config/saveConfig";
import { CONFIG_FILE } from "../../constants";

export default class Logout extends Command {
  static override readonly description =
    "unlink a Workspace from the local environment";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({
      description: "the Workspace to unlink from",
      required: true
    })
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Logout);
    const { ref } = args;
    const workspaces = getConfig(CONFIG_FILE);
    const updatedWorkspaces = removeWorkspace(ref, workspaces);
    saveConfig(CONFIG_FILE, updatedWorkspaces);
    this.log("Done!");
  }
}
