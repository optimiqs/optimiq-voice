import { confirm, input, number, select } from "@inquirer/prompts";
import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { UpdateAgentRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Update extends AuthenticatedCommand<typeof Update> {
  static override readonly description = "add a new SIP Agent to the network";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({
      description: "the ACL reference",
      required: true
    })
  };

  public async run(): Promise<void> {
    this.log("This utility will help you add a new SIP Agent to the network.");
    this.log("Press ^C at any time to quit.");

    const { args } = await this.parse(Update);
    const { ref } = args;
    const client = await this.createSdkClient();
    const agents = new SDK.Agents(client);
    const domains = new SDK.Domains(client);
    const credentials = new SDK.Credentials(client);

    const agentFromDB = await agents.getAgent(ref);

    if (!agentFromDB) {
      this.error("Agent not found.");
    }

    const domainsList = (
      await domains.listDomains({ pageSize: 1000 })
    ).items.map((d) => ({ name: d.name, value: d.ref }));

    const credentialsList = (
      await credentials.listCredentials({ pageSize: 1000 })
    ).items.map((c) => ({ name: c.name, value: c.ref }));

    const answers = {
      ref,
      name: await input({
        message: "Name",
        required: true,
        default: agentFromDB.name
      }),
      domainRef: await select({
        message: "Domain",
        choices: [{ name: "None", value: null }].concat(domainsList),
        default: agentFromDB.domain?.ref
      }),
      credentialsRef: await select({
        message: "Credentials",
        choices: [{ name: "None", value: null }].concat(credentialsList),
        default: agentFromDB.credentials?.ref
      }),
      privacy: await select({
        message: "Privacy",
        choices: [
          { name: "Private", value: "PRIVATE" },
          { name: "None", value: "NONE" }
        ],
        default: agentFromDB.privacy === "ID" ? "PRIVATE" : "NONE"
      }),
      enabled: await confirm({
        message: "Enabled?",
        default: agentFromDB.enabled
      }),
      maxContacts: await number({
        message: "Max Contacts",
        default: agentFromDB.maxContacts
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
      await agents.updateAgent(answers as unknown as UpdateAgentRequest);
      this.log("Done!");
    } catch (e) {
      errorHandler(e, this.error.bind(this));
    }
  }
}
