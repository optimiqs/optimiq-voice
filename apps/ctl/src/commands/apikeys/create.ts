import { Flags } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { Role } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../AuthenticatedCommand";

export default class Create extends AuthenticatedCommand<typeof Create> {
	static override readonly description = "create an API key for the active Workspace";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly flags = {
		expiration: Flags.string({
			char: "e",
			description: "API Key expiration time in days(e.g. 10d) or months(e.g. 10m)",
			required: false,
		}),
		role: Flags.string({
			char: "r",
			description: "API Key role",
			default: Role.WORKSPACE_ADMIN,
			required: false,
		}),
	};

	public async run(): Promise<void> {
		const { flags } = await this.parse(Create);

		const sdkClient = await this.createSdkClient();
		const apiKeys = new SDK.ApiKeys(sdkClient);
		const result = await apiKeys.createApiKey({
			role: flags.role as Role,
		});

		this.log("Access Key regenerated successfully!");
		this.log(`Access Key ID: ${result.accessKeyId}`);
		this.log(`Access Key Secret: ${result.accessKeySecret}`);
		this.log("");
		this.warn(
			"This is the only time the Access Key Secret will be shown.\nPlease copy it and store it securely!",
		);
	}
}
