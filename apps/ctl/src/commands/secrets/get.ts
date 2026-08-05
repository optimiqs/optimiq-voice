import { Args } from "@oclif/core";
import cliui from "cliui";
import moment from "moment";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../AuthenticatedCommand";

export default class Get extends AuthenticatedCommand<typeof Get> {
  static override readonly description =
    "retrieve details of a Secret by reference";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({
      description: "The Secret to show details about",
      required: true
    })
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Get);
    const client = await this.createSdkClient();
    const secrets = new SDK.Secrets(client);

    const response = await secrets.getSecret(args.ref);

    const ui = cliui({ width: 200 });

    ui.div(
      "APPLICATION DETAILS\n" +
        "------------------\n" +
        `NAME: \t${response.name}\n` +
        `REF: \t${response.ref}\n` +
        `CREATED: \t${moment(response.createdAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
        `UPDATED: \t${moment(response.updatedAt).format("YYYY-MM-DD HH:mm:ss")}`
    );

    this.log(ui.toString());
  }
}
