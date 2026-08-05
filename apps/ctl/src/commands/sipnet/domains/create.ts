import { confirm, input, select } from "@inquirer/prompts";
import * as SDK from "@optimiq-voice/sdk";
import { CreateDomainRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Create extends AuthenticatedCommand<typeof Create> {
  static override readonly description = "add a new Domain to the SIP network";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];

  public async run(): Promise<void> {
    this.log("This utility will help you create a new Domain.");
    this.log("Press ^C at any time to quit.");

    const client = await this.createSdkClient();
    const acls = new SDK.Acls(client);

    const aclsList = (await acls.listAcls({ pageSize: 1000 })).items.map(
      (item) => ({
        name: item.name,
        value: item.ref
      })
    );

    const answers = {
      name: await input({
        message: "Name",
        required: true
      }),
      domainUri: await input({
        message: "Domain URI",
        required: true
      }),
      accessControlListRef: await select({
        message: "Access Control List",
        choices: [{ name: "None", value: null }].concat(aclsList)
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
      const domains = new SDK.Domains(client);

      // Filter out null ACL reference
      const request: CreateDomainRequest = {
        name: answers.name,
        domainUri: answers.domainUri,
        ...(answers.accessControlListRef && {
          accessControlListRef: answers.accessControlListRef
        })
      };

      await domains.createDomain(request);

      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.error.bind(this));
    }
  }
}
