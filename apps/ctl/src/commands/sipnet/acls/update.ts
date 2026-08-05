import { confirm, input } from "@inquirer/prompts";
import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { UpdateAclRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Update extends AuthenticatedCommand<typeof Update> {
	static override readonly description = "update an existing Access Control List (ACL)";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly args = {
		ref: Args.string({
			description: "the ACL reference",
			required: true,
		}),
	};

	public async run(): Promise<void> {
		const { args } = await this.parse(Update);
		const { ref } = args;
		const client = await this.createSdkClient();
		const acls = new SDK.Acls(client);
		const aclFromDB = await acls.getAcl(ref);

		if (!aclFromDB) {
			this.error("ACL not found.");
		}

		this.log("This utility will help you update an existing Access Control List (ACL).");
		this.log("Press ^C at any time to quit.");

		const answers = {
			ref,
			name: await input({
				message: "Name",
				required: true,
				default: aclFromDB.name,
			}),
			allowString: await input({
				message: "Allow list (Comma separated list of IPs or CIDRs)",
				required: true,
				default: aclFromDB.allow.join(", "),
			}),
			confirm: await confirm({
				message: "Ready?",
			}),
		};

		if (!answers.confirm) {
			this.log("Aborted!");
			return;
		}

		try {
			await acls.updateAcl({
				...answers,
				allow: answers.allowString.split(",").map((a) => a.trim()),
			} as unknown as UpdateAclRequest);

			this.log("Done!");
		} catch (e) {
			errorHandler(e, this.error.bind(this));
		}
	}
}
