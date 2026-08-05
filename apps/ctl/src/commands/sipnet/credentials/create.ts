import { confirm, input, password } from "@inquirer/prompts";
import * as SDK from "@optimiq-voice/sdk";
import { CreateCredentialsRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Create extends AuthenticatedCommand<typeof Create> {
  static override readonly description =
    "add a new set of Credentials to the network";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];

  public async run(): Promise<void> {
    this.log(
      "This utility will help you add a new set of Credentials to the network."
    );
    this.log("Press ^C at any time to quit.");

    const answers = {
      name: await input({
        message: "Name",
        required: true
      }),
      username: await input({
        message: "Username",
        required: true
      }),
      password: await password({
        message: "Password"
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
      const client = await this.createSdkClient();
      const credentials = new SDK.Credentials(client);

      await credentials.createCredentials(
        answers as unknown as CreateCredentialsRequest
      );

      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.error.bind(this));
    }
  }
}
