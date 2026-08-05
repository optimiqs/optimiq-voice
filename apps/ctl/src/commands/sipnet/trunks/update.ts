import { confirm, input, number, select } from "@inquirer/prompts";
import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { UpdateTrunkRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Update extends AuthenticatedCommand<typeof Update> {
  static override readonly description = "modify the configuration of a Trunk";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({ description: "the Trunk to update", required: true })
  };

  public async run(): Promise<void> {
    this.log("This utility will help you update a Trunk.");
    this.log("Press ^C at any time to quit.");
    this.log("(The previous outbound values will be lost.)");

    const { args } = await this.parse(Update);
    const { ref } = args;
    const client = await this.createSdkClient();
    const trunks = new SDK.Trunks(client);
    const acls = new SDK.Acls(client);
    const credentials = new SDK.Credentials(client);
    const trunkFromDB = await trunks.getTrunk(ref);

    const listAcls = (await acls.listAcls({ pageSize: 100 })).items.map(
      (item) => ({
        name: item.name,
        value: item.ref
      })
    );

    const listCredentials = (
      await credentials.listCredentials({
        pageSize: 100
      })
    ).items.map((item) => ({
      name: item.name,
      value: item.ref
    }));

    const name = await input({
      message: "Friendly name",
      required: true,
      default: trunkFromDB.name
    });

    const inboundAnswers = {
      inboundUri: await input({
        message: "Inbound URI",
        required: true,
        default: trunkFromDB.inboundUri
      }),
      accessControlListRef: await select({
        message: "Access Control List",
        choices: [{ name: "None", value: null }].concat(listAcls),
        default: trunkFromDB.accessControlListRef
      }),
      inboundCredentialsRef: await select({
        message: "Inbound Credentials",
        choices: [{ name: "None", value: null }].concat(listCredentials),
        default: trunkFromDB.inboundCredentialsRef
      })
    };

    const needOutboundUri = await confirm({
      message: "Do you need an Outbound URI?"
    });

    let outboundAnswers = {};

    if (needOutboundUri) {
      outboundAnswers = {
        outboundCredentialsRef: await select({
          message: "Outbound Credentials",
          choices: [{ name: "None", value: null }].concat(listCredentials),
          default: trunkFromDB.outboundCredentialsRef
        }),
        uris: [
          {
            host: await input({
              message: "Host",
              required: true
            }),
            port: await number({
              message: "Port",
              required: true,
              default: 5060
            }),
            transport: await select({
              message: "Transport",
              choices: ["TCP", "UDP"]
            }),
            enabled: true,
            weight: 1,
            priority: 1,
            user: await input({
              message: "User"
            })
          }
        ]
      };
    }

    const confirmAnswers = await confirm({
      message: "Ready?"
    });

    if (!confirmAnswers) {
      this.log("Aborted!");
      return;
    }

    try {
      await trunks.updateTrunk({
        ref,
        name,
        sendRegister: true,
        ...inboundAnswers,
        ...outboundAnswers
      } as unknown as UpdateTrunkRequest);

      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.error.bind(this));
    }
  }
}
