import { Flags } from "@oclif/core";
import cliui from "cliui";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";

export default class List extends AuthenticatedCommand<typeof List> {
  static override readonly description =
    "display all SIP Agents in the network";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly flags = {
    "page-size": Flags.string({
      char: "s",
      description: "the number of items to show",
      default: "1000",
      required: false
    })
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(List);
    const client = await this.createSdkClient();
    const agents = new SDK.Agents(client);
    const response = await agents.listAgents({
      pageSize: parseInt(flags["page-size"])
    });

    const ui = cliui({ width: 150 });

    ui.div(
      { text: "REF", padding: [0, 0, 0, 0], width: 40 },
      { text: "NAME", padding: [0, 0, 0, 0], width: 25 },
      { text: "USERNAME", padding: [0, 0, 0, 0], width: 15 },
      { text: "PRIVACY", padding: [0, 0, 0, 0], width: 10 },
      { text: "ENABLED", padding: [0, 0, 0, 0], width: 0 }
    );

    response.items.forEach((agent) => {
      ui.div(
        { text: agent.ref, padding: [0, 0, 0, 0], width: 40 },
        { text: agent.name, padding: [0, 0, 0, 0], width: 25 },
        { text: agent.username, padding: [0, 0, 0, 0], width: 15 },
        { text: agent.privacy, padding: [0, 0, 0, 0], width: 10 },
        { text: agent.enabled + "", padding: [0, 0, 0, 0], width: 10 }
      );
    });

    this.log(ui.toString());
  }
}
