import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../AuthenticatedCommand";

export default class Regenerate extends AuthenticatedCommand<
  typeof Regenerate
> {
  static override readonly description =
    "generate a new access key secret for an API key";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({
      description: "the Application to update",
      required: true
    })
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Regenerate);
    const { ref } = args;

    const client = await this.createSdkClient();
    const apiKeys = new SDK.ApiKeys(client);
    const result = await apiKeys.regenerateApiKey(ref);

    this.log("Access Key created successfully!");
    this.log(`Access Key ID: ${result.accessKeyId}`);
    this.log(`Access Key Secret: ${result.accessKeySecret}`);
    this.log("");
    this.warn(
      "This is the only time the Access Key Secret will be shown.\nPlease copy it and store it securely!"
    );
  }
}
