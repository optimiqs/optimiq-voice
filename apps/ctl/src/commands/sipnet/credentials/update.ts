import { confirm, input, password } from "@inquirer/prompts";
import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { UpdateCredentialsRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Update extends AuthenticatedCommand<typeof Update> {
	static override readonly description = "modify the values or metadata of a set of Credentials";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly args = {
		ref: Args.string({
			description: "the Credentials reference",
			required: true,
		}),
	};

	public async run(): Promise<void> {
		const { args } = await this.parse(Update);
		const { ref } = args;
		const client = await this.createSdkClient();
		const credentials = new SDK.Credentials(client);
		const credentialsFromDB = await credentials.getCredentials(ref);

		if (!credentialsFromDB) {
			this.error("Credentials not found.");
		}

		this.log("This utility will help you modify the values or metadata of a set of Credentials.");
		this.log("Press ^C at any time to quit.");

		const answers = {
			ref,
			name: await input({
				message: "Name",
				required: true,
				default: credentialsFromDB.name,
			}),
			password: await password({
				message: "Secret",
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
			await credentials.updateCredentials({
				...answers,
			} as UpdateCredentialsRequest);

			this.log("Done!");
		} catch (e) {
			errorHandler(e, this.error.bind(this));
		}
	}
}
