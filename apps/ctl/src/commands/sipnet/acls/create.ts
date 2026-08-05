import { confirm, input } from "@inquirer/prompts";
import * as SDK from "@optimiq-voice/sdk";
import { CreateAclRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Create extends AuthenticatedCommand<typeof Create> {
  static override readonly description =
    "create a new Access Control List (ACL)";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];

  public async run(): Promise<void> {
    this.log(
      "This utility will help you create a new Access Control List (ACL)."
    );
    this.log("Press ^C at any time to quit.");

    const answers = {
      name: await input({
        message: "Name",
        required: true
      }),
      allowString: await input({
        message: "Allow list (Comma separated list of IPs or CIDRs)",
        required: true
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
      const acls = new SDK.Acls(client);

      await acls.createAcl({
        ...answers,
        allow: answers.allowString.split(",").map((a) => a.trim())
      } as unknown as CreateAclRequest);

      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.error.bind(this));
    }
  }
}
