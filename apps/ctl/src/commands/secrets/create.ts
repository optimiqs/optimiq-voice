import { confirm, input, password } from "@inquirer/prompts";
import * as SDK from "@optimiq-voice/sdk";
import { CreateSecretRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../AuthenticatedCommand";
import errorHandler from "../../errorHandler";

export default class Create extends AuthenticatedCommand<typeof Create> {
	static override readonly description = "add a new Secret to the active Workspace";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<void> {
		this.log("This utility will help you add a new Secret to the active Workspace.");
		this.log("Press ^C at any time to quit.");

		const answers = {
			name: await input({
				message: "Name",
				required: true,
			}),
			secret: await password({
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
			const client = await this.createSdkClient();
			const secrets = new SDK.Secrets(client);

			await secrets.createSecret(answers as unknown as CreateSecretRequest);

			this.log("Done!");
		} catch (e) {
			errorHandler(e, this.error.bind(this));
		}
	}
}
