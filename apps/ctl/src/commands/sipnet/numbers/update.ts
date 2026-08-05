import { confirm, input, select } from "@inquirer/prompts";
import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { UpdateNumberRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Update extends AuthenticatedCommand<typeof Update> {
  static override readonly description = "modify the configuration of a Number";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({ description: "the Number to update", required: true })
  };

  public async run(): Promise<void> {
    this.log("This utility will help you update a Number.");
    this.log("Press ^C at any time to quit.");

    const { args } = await this.parse(Update);
    const { ref } = args;
    const client = await this.createSdkClient();
    const trunks = new SDK.Trunks(client);
    const applications = new SDK.Applications(client);
    const numbers = new SDK.Numbers(client);

    const applicationFromDB = await numbers.getNumber(ref);

    if (!applicationFromDB) {
      this.error("Application not found.");
    }

    const trunksList = (await trunks.listTrunks({ pageSize: 1000 })).items.map(
      (item) => ({
        name: item.name,
        value: item.ref
      })
    );

    const applicationsList = (
      await applications.listApplications({ pageSize: 1000 })
    ).items.map((item) => ({
      name: item.name,
      value: item.ref
    }));

    const answers = {
      ref,
      name: await input({
        message: "Friendly name",
        required: true,
        default: applicationFromDB.name
      }),
      trunkRef: await select({
        message: "Trunk",
        choices: [{ name: "None", value: null }].concat(trunksList),
        default: applicationFromDB.trunk?.ref
      }),
      appRef: await select({
        message: "Application",
        choices: [{ name: "None", value: null }].concat(applicationsList),
        default: applicationFromDB.appRef
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
      await numbers.updateNumber(answers as unknown as UpdateNumberRequest);

      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.error.bind(this));
    }
  }
}
