import { Args } from "@oclif/core";
import cliui from "cliui";
import moment from "moment";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";

export default class Get extends AuthenticatedCommand<typeof Get> {
	static override readonly description = "retrieve details of a set of Credentials by reference";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly args = {
		ref: Args.string({
			description: "The Credentials reference",
			required: true,
		}),
	};

	public async run(): Promise<void> {
		const { args } = await this.parse(Get);
		const { ref } = args;
		const client = await this.createSdkClient();
		const credentials = new SDK.Credentials(client);

		const response = await credentials.getCredentials(ref);

		const ui = cliui({ width: 200 });

		ui.div(
			"CREDENTIALS DETAILS\n" +
				"------------------\n" +
				`NAME: \t${response.name}\n` +
				`REF: \t${response.ref}\n` +
				`USERNAME: \t${response.username}\n` +
				`CREATED: \t${moment(response.createdAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
				`UPDATED: \t${moment(response.updatedAt).format("YYYY-MM-DD HH:mm:ss")}`,
		);

		this.log(ui.toString());
	}
}
