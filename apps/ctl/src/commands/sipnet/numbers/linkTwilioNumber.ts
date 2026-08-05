import { confirm, input, password, select } from "@inquirer/prompts";
import { Flags } from "@oclif/core";
import { Twilio } from "twilio";
import * as OptimiqVoice from "@optimiq-voice/sdk";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import { getActiveWorkspace, getConfig } from "../../../config";
import {
	CONFIG_FILE,
	OPTIMIQ_VOICE_ACCESS_CONTROL_LIST,
	OPTIMIQ_VOICE_ORIGINATION_URI_BASE,
} from "../../../constants";
import { linkTwilioNumberToApplication } from "../../../utils";

export default class LinkTwilioNumber extends AuthenticatedCommand<typeof LinkTwilioNumber> {
	static override readonly description =
		"associate a Twilio number with a Optimiq Voice Application";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];
	static override readonly flags = {
		"outbound-uri-base": Flags.string({
			char: "b",
			description:
				"the uri to point twilio to for outbound calls (use if running your Optimiq Voice instance)",
			default: OPTIMIQ_VOICE_ORIGINATION_URI_BASE,
			required: false,
		}),
		"access-control-list": Flags.string({
			char: "a",
			description: "the access control list to allow (use if running your Optimiq Voice instance)",
			default: OPTIMIQ_VOICE_ACCESS_CONTROL_LIST.join(","),
			required: false,
		}),
	};

	public async run(): Promise<void> {
		const { flags } = await this.parse(LinkTwilioNumber);
		const optimiqVoiceClient = await this.createSdkClient();
		const applications = new OptimiqVoice.Applications(optimiqVoiceClient);
		const appsList = (await applications.listApplications({ pageSize: 1000 })).items.map((app) => ({
			name: app.name,
			value: app.ref,
		}));

		this.log("This utility will help you create an Application.");
		this.log("Press ^C at any time to quit.");

		const answers = {
			friendlyName: await input({
				message: "Friendly Name",
			}),
			number: await input({
				message: "Number to link (E.164 format)",
				required: true,
			}),
			applicationRef: await select({
				message: "Application",
				choices: [{ name: "None", value: null }].concat(appsList),
			}),
			twilioAccountSid: await input({
				message: "Twilio Account SID",
				required: true,
			}),
			twilioAuthToken: await password({
				message: "Twilio Auth Token",
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
			const twilioClient = new Twilio(answers.twilioAccountSid, answers.twilioAuthToken);

			const activeWorkspace = getActiveWorkspace(getConfig(CONFIG_FILE));
			const accessKeyId = activeWorkspace.workspaceAccessKeyId;

			await linkTwilioNumberToApplication(twilioClient, optimiqVoiceClient, {
				phoneNumber: answers.number,
				accessKeyId,
				aclEntries: flags["access-control-list"].split(","),
				originationUriBase: flags["outbound-uri-base"],
				applicationRef: answers.applicationRef,
				friendlyName: answers.friendlyName,
			});
		} catch (error: unknown) {
			this.error(`Failed to link number: ${(error as Error).message}`);
		}
	}
}
