import { Args } from "@oclif/core";
import cliui from "cliui";
import moment from "moment";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";

export default class Get extends AuthenticatedCommand<typeof Get> {
	static override readonly description = "get a specific Access Control List (ACL)";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly args = {
		ref: Args.string({
			description: "The ACL reference",
			required: true,
		}),
	};

	public async run(): Promise<void> {
		const { args } = await this.parse(Get);
		const { ref } = args;
		const client = await this.createSdkClient();
		const acls = new SDK.Acls(client);

		const response = await acls.getAcl(ref);

		const ui = cliui({ width: 200 });

		ui.div(
			"ACL DETAILS\n" +
				"------------------\n" +
				`NAME: \t${response.name}\n` +
				`REF: \t${response.ref}\n` +
				`ALLOW LIST: \t${response.allow.join(", ")}\n` +
				`CREATED: \t${moment(response.createdAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
				`UPDATED: \t${moment(response.updatedAt).format("YYYY-MM-DD HH:mm:ss")}`,
		);

		this.log(ui.toString());
	}
}
