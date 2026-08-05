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
		const calls = new SDK.Calls(client);

		const response = await calls.getCall(ref);

		const ui = cliui({ width: 200 });

		ui.div(
			"CALL DETAILS\n" +
				"------------------\n" +
				`REF: \t${response.ref}\n` +
				`CALL ID: \t${(response as unknown as { callId: string }).callId}\n` +
				`TYPE: \t${response.type}\n` +
				`STATUS: \t${response.status}\n` +
				`FROM: \t${response.from}\n` +
				`TO: \t${response.to}\n` +
				`DURATION: \t${response.duration}\n` +
				`DIRECTION: \t${response.direction}\n` +
				`STARTED: \t${moment(response.startedAt).format("YYYY-MM-DD HH:mm:ss")}\n` +
				`ENDED: \t${moment(response.endedAt).format("YYYY-MM-DD HH:mm:ss")}`,
		);

		this.log(ui.toString());
	}
}
