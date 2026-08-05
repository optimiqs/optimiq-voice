import { Args } from "@oclif/core";
import cliui from "cliui";
import moment from "moment";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";

export default class Get extends AuthenticatedCommand<typeof Get> {
  static override readonly description = "retrieve details of a SIP Agent";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({
      description: "The Agent reference",
      required: true
    })
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Get);
    const { ref } = args;
    const client = await this.createSdkClient();
    const agents = new SDK.Agents(client);

    const response = await agents.getAgent(ref);

    console.log(response);

    const ui = cliui({ width: 200 });

    ui.div(
      "AGENT DETAILS\n" +
        "------------------\n" +
        `NAME: \t${response.name}\n` +
        `REF: \t${response.ref}\n` +
        `USERNAME: \t${response.username}\n` +
        `DOMAIN NAME: \t${response.domain?.name ?? ""}\n` +
        `DOMAIN REF: \t${response.domain?.ref ?? ""}\n` +
        `CREDENTIALS NAME: \t${response.credentials?.name ?? ""}\n` +
        `CREDENTIALS REF: \t${response.credentials?.ref ?? ""}\n` +
        `PRIVACY: \t${response.privacy}\n` +
        `ENABLED: \t${response.enabled}\n` +
        `MAX CONTACTS: \t${response.maxContacts === -1 ? "" : response.maxContacts}\n` +
        `CREATED: \t${moment(response.createdAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
        `UPDATED: \t${moment(response.updatedAt).format("YYYY-MM-DD HH:mm:ss")}`
    );

    this.log(ui.toString());
  }
}
