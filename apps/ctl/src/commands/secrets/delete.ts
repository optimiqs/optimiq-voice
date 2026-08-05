import { Args } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../AuthenticatedCommand";

export default class Delete extends AuthenticatedCommand<typeof Delete> {
	static override readonly description = "delete a Secret from the active Workspace";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly args = {
		ref: Args.string({
			description: "the Secret reference",
			required: true,
		}),
	};

	public async run(): Promise<void> {
		const { args } = await this.parse(Delete);
		const { ref } = args;
		const client = await this.createSdkClient();
		const secrets = new SDK.Secrets(client);
		await secrets.deleteSecret(ref);
		this.log("Done!");
	}
}
