import { confirm, input, number, select } from "@inquirer/prompts";
import * as SDK from "@optimiq-voice/sdk";
import { CreateTrunkRequest } from "@optimiq-voice/types";
import { AuthenticatedCommand } from "../../../AuthenticatedCommand";
import errorHandler from "../../../errorHandler";

export default class Create extends AuthenticatedCommand<typeof Create> {
	static override readonly description = "add a new Trunk to the SIP network";
	static override readonly examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<void> {
		this.log("This utility will help you add a new Trunk to the SIP network.");
		this.log("Press ^C at any time to quit.");

		const client = await this.createSdkClient();
		const trunks = new SDK.Trunks(client);
		const acls = new SDK.Acls(client);
		const credentials = new SDK.Credentials(client);

		const listAcls = (await acls.listAcls({ pageSize: 100 })).items.map((item) => ({
			name: item.name,
			value: item.ref,
		}));

		const listCredentials = (
			await credentials.listCredentials({
				pageSize: 100,
			})
		).items.map((item) => ({
			name: item.name,
			value: item.ref,
		}));

		const name = await input({
			message: "Friendly name",
			required: true,
		});

		const inboundAnswers = {
			inboundUri: await input({
				message: "Inbound URI",
				required: true,
			}),
			accessControlListRef: await select({
				message: "Access Control List",
				choices: [{ name: "None", value: null }].concat(listAcls),
			}),
		};

		const needOutboundUri = await confirm({
			message: "Do you need an Outbound URI?",
		});

		let outboundAnswers = {};

		if (needOutboundUri) {
			outboundAnswers = {
				outboundCredentialsRef: await select({
					message: "Outbound Credentials",
					choices: [{ name: "None", value: null }].concat(listCredentials),
				}),
				uris: [
					{
						host: await input({
							message: "Host",
							required: true,
						}),
						port: await number({
							message: "Port",
							required: true,
							default: 5060,
						}),
						transport: await select({
							message: "Transport",
							choices: ["TCP", "UDP"],
						}),
						enabled: true,
						weight: 1,
						priority: 1,
						user: await input({
							message: "User",
						}),
					},
				],
			};
		}

		const confirmAnswers = await confirm({
			message: "Ready?",
		});

		if (!confirmAnswers) {
			this.log("Aborted!");
			return;
		}

		try {
			await trunks.createTrunk({
				name,
				sendRegister: true,
				...inboundAnswers,
				...outboundAnswers,
			} as unknown as CreateTrunkRequest);

			this.log("Done!");
		} catch (e) {
			errorHandler(e, this.error.bind(this));
		}
	}
}
