import { confirm, input, password } from "@inquirer/prompts";
import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { UpdateSecretRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../AuthenticatedCommand";
import errorHandler from "../../errorHandler";

export default class Update extends AuthenticatedCommand<typeof Update> {
  static override readonly description =
    "modify the value or metadata of a Secret";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({ description: "the Secret to update", required: true })
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Update);
    const client = await this.createSdkClient();
    const secrets = new SDK.Secrets(client);
    const secretFromDB = await secrets.getSecret(args.ref);

    if (!secretFromDB) {
      this.error("Secret not found.");
    }

    this.log("This utility will help you update a Secret.");
    this.log("Press ^C at any time to quit.");

    const answers = {
      name: await input({
        message: "Name",
        required: true,
        default: secretFromDB.name
      }),
      type: await password({
        message: "Secret"
      }),
      confirm: await confirm({
        message: "Ready?"
      })
    };

    if (!answers.confirm) {
      this.log("Aborted!");
      return;
    }

    try {
      await secrets.updateSecret({
        ref: args.ref,
        ...answers
      } as UpdateSecretRequest);

      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.log.bind(this));
    }
  }
}
