import { Args } from "@oclif/core";
import cliui from "cliui";
import moment from "moment";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";

export default class Get extends AuthenticatedCommand<typeof Get> {
  static override readonly description =
    "retrieve details of a Domain by reference";
  static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
  static override readonly args = {
    ref: Args.string({
      description: "The Domain reference",
      required: true
    })
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Get);
    const { ref } = args;
    const client = await this.createSdkClient();
    const domains = new SDK.Domains(client);

    const response = await domains.getDomain(ref);

    const ui = cliui({ width: 200 });

    ui.div(
      "DOMAIN DETAILS\n" +
        "------------------\n" +
        `NAME: \t${response.name}\n` +
        `REF: \t${response.ref}\n` +
        `DOMAIN URI: \t${response.domainUri}\n` +
        `CREATED: \t${moment(response.createdAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
        `UPDATED: \t${moment(response.updatedAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
        (response.accessControlList
          ? `\nACCESS CONTROL LIST:\n` +
            `  NAME: \t${response.accessControlList.name}\n` +
            `  REF: \t${response.accessControlList.ref}\n` +
            `  ALLOW: \t${response.accessControlList.allow.join(", ") || "None"}\n` +
            `  DENY: \t${response.accessControlList.deny.join(", ") || "None"}`
          : `\nACCESS CONTROL LIST: \tNone`) +
        (response.egressPolicies && response.egressPolicies.length > 0
          ? `\n\nEGRESS POLICIES:\n` +
            response.egressPolicies
              .map(
                (policy, index) =>
                  `  ${index + 1}. Rule: ${policy.rule}, Number: ${policy.numberRef}`
              )
              .join("\n")
          : `\n\nEGRESS POLICIES: \tNone`)
    );

    this.log(ui.toString());
  }
}
